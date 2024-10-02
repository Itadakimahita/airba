import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import serveStatic from 'serve-static';

import { sendSMSAuthorization, verifySms, getLists, refreshToken } from './api/auth';
import { getNumberByName, extractNameAndNumber, User, Users } from './utils/user';
import { initializeSession, sendResponse, Sessions, Session, endResponse } from './utils/session';
import { apiConfig, updateTokens } from './middleware/config';  // Import the config and token update functions
import { checkProducts, getCartProducts, listToCart } from './api/cart';
import { closestTimeSlot, orderCreate, paymentCards, workflowCheckout } from './api/order';
import { paymentApply, paymentConfirm } from './api/payment';

const app = express();
app.use(bodyParser.json());

// Static assets middleware
app.use(serveStatic('public'));


export let userSessions: Sessions = {};

const newProducts = [
    { name: 'яблоки', description: 'сочный плод яблони, который употребляется в пищу в свежем и запеченном виде.' },
    { name: 'груши', description: 'род плодовых и декоративных деревьев и кустарников семейства розовые.' }
];

app.post('/webhook', async (req: Request, res: Response) => {
    const data = req.body;
    const userInput = data.request.command.toLowerCase();
    const yandexUserId = data.session.user_id;
    const savedUsers: Users = data.state?.user?.users || {};

    if (!userSessions[yandexUserId]) {
        userSessions[yandexUserId] = initializeSession();
    }
    const session = userSessions[yandexUserId];

    session.proccessDone = false;

    if (session.awaitingProccess) {
        if(userInput.includes('нет')){
            endResponse(res, data, 'Всего доброго', savedUsers);
        }
        session.awaitingProccess = false;
        sendResponse(session, res, data, session.awaitingResponseText, savedUsers);
    } else {
        // resetSessionTimer(session, res, data, savedUsers);
        await main(data, userInput, session, res, savedUsers);

    }
});

// async function resetSessionTimer(session: Session, res: Response, data: any, savedUsers: Users) {
//     if (session.timerCount) clearTimeout(session.timerCount);

    
//     session.timerCount = setTimeout(() => {
//         sendResponse(session, res, data, 'Ваш запрос обрабатывается, хотите продолжить?', savedUsers);
//         session.awaitingProccess = true;
//         session.timerCount = null;
//     }, 1500)
// }

async function raceWithTimeout(taskPromise: Promise<any>, timeoutMessage: string, timeoutDuration = 2100) {
    const timeout = new Promise((resolve) => {
        setTimeout(() => {
            resolve(timeoutMessage);
        }, timeoutDuration);
    });

    return Promise.race([taskPromise, timeout]);
}


async function main(data: any, userInput: string, session: Session, res: Response, savedUsers: any) {
    let responseText = '';

    const entireProcessPromise = new Promise(async (resolve) => {
        if (session.endingSession) {
            responseText = 'Всего доброго';
            endResponse(res, data, responseText, savedUsers);
            resolve(responseText);
        } else if (session.paymentOrder) {
            responseText = await confirmingUserPayment(userInput, session, res);
            session.awaitingResponseText = responseText;
            resolve(responseText);
        } else if (session.confirmingOrder) {
            responseText = await confirmingUserOrder(userInput, session, res);
            session.awaitingResponseText = responseText;
            resolve(responseText);
        } else if (session.selectedUser && session.selectedUser.auth) {
            responseText = await processUserCommands(userInput, session, res);
            session.awaitingResponseText = responseText;
            resolve(responseText);
        } else {
            responseText = await handleAuthFlow(userInput, session, res, savedUsers);
            session.awaitingResponseText = responseText;
            resolve(responseText);
        }
    });

    // Используем Promise.race для отслеживания общего времени выполнения
    responseText = await raceWithTimeout(entireProcessPromise, 'Запрос в обработке, хотите продолжить?', 2100);

    sendResponse(session, res, data, responseText, savedUsers);
}

async function handleAuthFlow(userInput: string, session: Session, res: Response, savedUsers: any): Promise<string> {
    let responseText = "";

    if(userInput.includes('новый')){
        session.addingAccount = true;
        session.awaitingAuth = false;
        responseText = 'Пожалуйста добавьте пользователя, для этого скажите имя и номер телефона';
    } else if (session.addingAccount) {
        const [name, number] = extractNameAndNumber(userInput);
        if (name && number) {
            savedUsers[name] = {
                number: number,
                token: null,
                old_token: null,
            }
            responseText = `Пользователь ${name} добавлен. Выберите пользователя, сказав его имя.`;
            session.addingAccount = false;
            session.awaitingAuth = true;
        } else {
            responseText = "Ошибка добавления пользователя. Пожалуйста, повторите.";
        }
    } 
    else if (session.awaitingAuth) {
        const number = getNumberByName(userInput, savedUsers);
        let refreshed = false;
        if(savedUsers[userInput]){
            if(savedUsers[userInput].token && savedUsers[userInput].old_token && number){
                const old_token = savedUsers[userInput].old_token;
                const newToken = await refreshToken(savedUsers[userInput].token, savedUsers[userInput].old_token);
                
                if(newToken){
                    session.selectedUser = {name: userInput, number: number, auth: newToken};
                    savedUsers[userInput] = {number: number, token: newToken, old_token: old_token}
                    refreshed = true
                    responseText = "Авторизация успешна. Теперь вы можете запросить новинки или добавить продукты в корзину для этого скажите \"Добавь\" и название вашего списка.";
                }
            }
        }
        
        if (number && !refreshed) {
            await sendSMSAuthorization(number, session.workflow);
            session.awaitingSms = true;
            session.selectedUser = {name: userInput, number: number, auth: null};
            responseText = `Для пользователя ${userInput} отправлено SMS. Скажите код.`;
        } 
        else if (session.awaitingSms && session.selectedUser) {
            const [ accessToken, refreshToken ] = await verifySms(session.selectedUser.number, userInput, session.workflow);
            if (accessToken && refreshToken) {
                // Add or update user data
                savedUsers[session.selectedUser.name] = {
                    number: session.selectedUser.number,
                    token: refreshToken,
                    old_token: accessToken,
                };
                                
                
                session.selectedUser.auth = accessToken;
                responseText = "Авторизация успешна. Теперь вы можете запросить новинки или добавить продукты в корзину для этого скажите \"Добавь\" и название вашего списка.";
            } else {
                responseText = "Неверный код. Попробуйте снова.";
            }
        }
        else if(!refreshed && !number){
            responseText = "Такого пользователя не существует, пожалуйста повторите! Или добавьте нового";
        }
    }
    else if(Object.keys(savedUsers).length === 0){
        session.addingAccount = true;
        responseText = 'Пожалуйста добавьте пользователя, для этого скажите имя и номер телефона';
    }
    else{
        session.awaitingAuth = true;
        responseText = `Пожалуйтса выберите пользователя из существующих ${Object.keys(savedUsers).join(', ')} или добавьте нового сказав, новый пользователь`;
    }


    return responseText;
}

async function processUserCommands(userInput: string, session: Session, res: Response): Promise<string> {
    let responseText = "";

    if (userInput.includes("новинки")) {
        responseText = "Вот новинки: " + newProducts.map(product => `${product.name}: ${product.description}`).join(", ");
    } 
    else if(userInput.includes('заказ')){
        responseText = 'Ваш заказ на ' + (await getCartProducts(session.workflow)).join()
    }
    else if(userInput.includes('достаточно') || userInput.includes('нет') || userInput.includes('все')){
        responseText = 'Хотите оформить заказ на ' + (await getCartProducts(session.workflow)).join()
        session.confirmingOrder = true
    }
    else if (userInput.includes("добавь") || userInput.includes("закажи")) {
        if(session.selectedUser?.auth){
            const products = await getLists(session.selectedUser?.auth, session.workflow);  // Fetch products using access token
            const productToAdd = products.find(product => userInput.includes(product.title.toLowerCase()));
            
            if (productToAdd) {
                const productsCount = await checkProducts(session.workflow, session.selectedUser.auth, productToAdd.id)
                let hasInStock: string[] = [];
                productsCount.forEach(el => {
                    if(el.stockCount < 1) hasInStock.push(el.name);
                });
                if(hasInStock.length === 0){
                    listToCart(session.selectedUser.auth, session.workflow, productToAdd.id)
                    responseText = `${productToAdd.title} добавлен в корзину. Что-нибудь еще?`;  
                } else {
                    responseText = `Извините, но сейчас товаров: ${hasInStock.join(' ')} нет на скалде, можеты вы хотели бы заказть что-нибудь еще?`
                }
                
            } else {
                responseText = "Продукт не найден. Пожалуйста, попробуйте снова.";
            }
        }
        
    } 
    else {
        responseText = "Неизвестная команда. Вы можете запросить новинки или добавить продукты в корзину. Для этого скажите слово перед названием списка \"Добавь\"";
    }

    return responseText;
}

async function confirmingUserOrder(userInput: string, session: Session, res: Response): Promise<string> {
    let responseText = "";

    if (userInput.includes("да")) {
        if(session.selectedUser && session.selectedUser.auth){
            const payment_card = await paymentCards(session.selectedUser?.auth, session.workflow);
            const timeslot = await closestTimeSlot(session.workflow);
            if(payment_card && timeslot){
                const price = await workflowCheckout(session.workflow, session.selectedUser.auth, timeslot, payment_card);
                responseText = `Оплатить заказ на сумму ${price ? price : 'ошибка'} тг?`;
                session.paymentOrder = true;
            } else{
                responseText = "Скорее всего у вас нет выбранной карты в приложении, пожалуйста подключите способ оплаты";
            }
        }
        
    } else if(userInput.includes('нет')){
        responseText = 'Заказ отменен';
        session.confirmingOrder = false;
    } else {
        responseText = "Извините я вас не поняла, хотите оформить заказ?";
    }

    return responseText;
}

async function confirmingUserPayment(userInput: string, session: Session, res: Response): Promise<string> {
    let responseText = "Извините что-то пошло не так, попробуйте еще раз";

    if (userInput.includes("да")) {
        if(session.selectedUser && session.selectedUser.auth){
            if(await orderCreate(session.workflow, session.selectedUser.auth)){
                console.log('ordere');
                
                const order_token = await paymentApply(session.workflow, session.selectedUser.auth);
                if(order_token){
                    console.log('order_token');
                    
                    const result = await paymentConfirm(session.workflow, session.selectedUser.auth);
                    if(result){
                        console.log('result');
                        
                        session.workflow = Promise.resolve(result.workflowUUID);
                        responseText = `Ваш заказ на сумму ${result.deliveryInfo?.total_price} тг по адрессу ${result.deliveryInfo?.address}
                         прибудет от ${result.deliveryInfo?.startTime} до ${result.deliveryInfo?.endTime}`;
                        session.confirmingOrder = false;
                        session.paymentOrder = false;
                        session.endingSession = true;
                    }
                }
            } 
        }
        
    } else if(userInput.includes('нет')){
        responseText = 'Заказ отменен';
        session.confirmingOrder = false;
        session.paymentOrder = false;
    } else {
        responseText = "Извините я вас не поняла, хотите оплатить заказ?";
    }

    return responseText;
}

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
