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
    
    if (!userSessions[yandexUserId]) {
        userSessions[yandexUserId] = initializeSession();
    }
    const session = userSessions[yandexUserId];

    const savedUsers: Users = (session.savedUsers) ? session.savedUsers : (data.state?.user?.users || {});


    if (session.endingSession) {
        delete userSessions[yandexUserId];
        endResponse(res, data, 'Всего доброго', savedUsers);
    }
    else if (session.awaitingProccess) {
        if(userInput.includes('нет')){
            delete userSessions[yandexUserId];
            endResponse(res, data, 'Всего доброго', savedUsers);
        } else {
            if (session.proccessDone){
                session.awaitingProccess = false;
                sendResponse(session, res, data, session.awaitingResponseText, savedUsers);
            } else {
                session.awaitingProccess = true;
                sendResponse(session, res, data, 'Запрос в обработке, хотите продолжить?', savedUsers);
            }
            
            
        }
    } else {
        // resetSessionTimer(session, res, data, savedUsers);
        session.proccessDone = false;
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

async function raceWithTimeout(taskPromise: Promise<any>, timeoutMessage: string, timeoutDuration = 4500) {
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
        if (session.paymentOrder) {
            responseText = await confirmingUserPayment(userInput, session, res);
            session.awaitingResponseText = responseText;
            resolve(responseText)
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
    responseText = await raceWithTimeout(entireProcessPromise.finally(() => session.proccessDone = true), 'Запрос в обработке, хотите продолжить?', 2300);
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
                const refresh_token = savedUsers[userInput].token;
                const newToken = await refreshToken(savedUsers[userInput].token, savedUsers[userInput].old_token);
                
                if(newToken){
                    session.selectedUser = {name: userInput, number: number, auth: newToken};
                    savedUsers[session.selectedUser.name] = {
                        number: session.selectedUser.number,
                        token: refresh_token,
                        old_token: newToken,
                    };
                    console.log(savedUsers);
                    session.savedUsers = savedUsers;
                    
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

                console.log(accessToken, refreshToken);
                
                if (savedUsers[session.selectedUser.name]) {
                    savedUsers[session.selectedUser.name] = {
                        number: session.selectedUser.number, 
                        token: refreshToken,
                        old_token: accessToken,
                    };
                } else {
                    // Если пользователь новый, создаем новую запись
                    savedUsers[session.selectedUser.name] = {
                        number: session.selectedUser.number,
                        token: refreshToken,
                        old_token: accessToken,
                    };
                }
                console.log(savedUsers);
                session.savedUsers = savedUsers;
                
                                
                
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
        responseText = 'Ваш заказ на ' + (await getCartProducts(session.workflow)).join(', ') + ' хотели бы заказать что-нибудь еще?'
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
                    responseText = `Извините, но сейчас товаров: ${hasInStock.join(' ')} нет на складе, может вы хотели бы заказать что-нибудь еще?`
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
                session.priceOrder = price;
                responseText = `Оплатить заказ на сумму ${price ? price : 'ошибка'} тенге?`;
                session.paymentOrder = true;
                session.confirmingOrder = false;
            } else{
                responseText = "Скорее всего у вас нет выбранной карты в приложении, пожалуйста подключите способ оплаты";
            }
        }
        
    } else if(userInput.includes('нет')){
        responseText = 'Заказ отменен';
        session.confirmingOrder = false;
        session.endingSession = true;
    } else {
        responseText = "Извините я вас не поняла, хотите оформить заказ?";
    }

    return responseText;
}

async function confirmingUserPayment(userInput: string, session: Session, res: Response): Promise<string> {
    let responseText = "";

    if (userInput.includes("да")) {
        if(session.selectedUser && session.selectedUser.auth){
            if(await orderCreate(session.workflow, session.selectedUser.auth)){
                console.log('order');
                
                const order_token = await paymentApply(session.workflow, session.selectedUser.auth);
                if(order_token){
                    console.log('order_token');
                    
                    const result = await paymentConfirm(session.workflow, session.selectedUser.auth);
                    if(result){
                        console.log('result');
                        
                        session.workflow = Promise.resolve(result.workflowUUID);
                        responseText = `Ваш заказ на сумму ${session.priceOrder} тенге оформлен по адрессу ${result.deliveryInfo?.address}
                         прибудет от ${result.deliveryInfo?.startTime} до ${result.deliveryInfo?.endTime}. Для завершения сесси скажите \"Хватит\"`;
                        session.confirmingOrder = false;
                        session.paymentOrder = false;
                    }
                }
            } 
        }
        
    } else if(userInput.includes('нет')){
        responseText = 'Заказ отменен';
        session.confirmingOrder = false;
        session.paymentOrder = false;
        session.endingSession = true;
    } else {
        responseText = "Извините я вас не поняла, хотите оплатить заказ?";
    }

    return responseText;
}

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
