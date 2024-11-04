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

import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StateGraph } from "@langchain/langgraph";
import { MemorySaver, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOllama } from '@langchain/ollama';

require('dotenv').config();


const StateAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (x, y) => x.concat(y),
    })
})

// // Определим инструменты для каждой из API-функций
// const sendSMSTool = tool(async ({ number, workflow }) => {
//     return await sendSMSAuthorization(number, workflow);
// }, {
//     name: "sendSMSAuthorization",
//     description: "Send SMS to user for authorization",
//     schema: z.object({
//         number: z.string().describe("Phone number of the user"),
//         workflow: z.string().describe("Workflow ID")
//     }),
// });

// const verifySmsTool = tool(async ({ number, code, workflow }) => {
//     return await verifySms(number, code, workflow);
// }, {
//     name: "verifySms",
//     description: "Verify SMS code",
//     schema: z.object({
//         number: z.string().describe("Phone number of the user"),
//         code: z.string().describe("SMS code for verification"),
//         workflow: z.string().describe("Workflow ID")
//     }),
// });

// const getListsTool = tool(async ({ auth, workflow }) => {
//     return await getLists(auth, workflow);
// }, {
//     name: "getLists",
//     description: "Get product lists",
//     schema: z.object({
//         auth: z.string().describe("User's auth token"),
//         workflow: z.string().describe("Workflow ID")
//     }),
// });

// Добавляем другие инструменты для корзины и продуктов
const getCartProductsTool = tool(async ({}, config) => {
    const configuration = config['configurable'];
    const workflow = configuration['thread_id'];
    const responseText = 'Ваш заказ на ' + (await getCartProducts(workflow)).join(', ') + ' хотели бы заказать что-нибудь еще?';
    return responseText;
}, {
    name: "getCartProducts",
    description: "Get products from cart",
    schema: z.object({
        workflow: z.string().describe("Workflow ID"),
    }),
});

const listToCartTool = tool(async ({ userInput }, config) => {
    // Проверяем, есть ли auth и workflow в сессии
    const configuration = config['configurable'];
    const auth = configuration['auth_token'];
    const workflow = configuration['thread_id'];

    if (!auth || !workflow) {
        return "Ошибка: не удалось найти авторизационные данные. Пожалуйста, войдите в систему.";
    }

    const products = await getLists(auth, workflow); 
    
    const productToAdd = products.find(product => userInput.toLowerCase().includes(product.title.toLowerCase()));
    
    if (productToAdd) {
        const productsCount = await checkProducts(workflow, auth, productToAdd.id);
        let outOfStockItems: string[] = [];

        productsCount.forEach(item => {
            if (item.stockCount < 1) outOfStockItems.push(item.name);
        });

        if (outOfStockItems.length === 0) {
            await listToCart(auth, workflow, productToAdd.id);
            return `${productToAdd.title} добавлен в корзину. Что-нибудь еще?`;
        } else {
            return `Извините, но товаров: ${outOfStockItems.join(', ')} нет на складе. Хотите заказать что-то другое?`;
        }
    } else {
        return "Продукт не найден. Пожалуйста, попробуйте снова.";
    }
}, {
    name: "listToCart",
    description: "Add product to cart",
    schema: z.object({
        userInput: z.string().describe("User input containing product list name")
    }),
});

const confirmOrderTool = tool(async ({ userInput }, config) => {
    const configuration = config['configurable'];
    const auth = configuration['auth_token'];
    const workflow = configuration['thread_id'];

    if (!auth || !workflow) {
        return "Ошибка: не удалось найти авторизационные данные. Пожалуйста, войдите в систему.";
    }

        const payment_card = await paymentCards(auth, workflow);
        const timeslot = await closestTimeSlot(workflow);
        
        if (payment_card && timeslot) {
            const price = await workflowCheckout(workflow, auth, timeslot, payment_card);
            return `Оплатить заказ на сумму ${price ? price : 'ошибка'} тенге?`;
        } else {
            return "Скорее всего у вас нет выбранной карты в приложении, пожалуйста подключите способ оплаты";
        }
}, {
    name: "confirmOrder",
    description: "Confirm the order placement after adding listToCart",
    schema: z.object({
        userInput: z.string().describe("User's input for confirming the order")
    })
});

const confirmPaymentTool = tool(async ({ userInput }, config) => {
    const configuration = config['configurable'];
    const auth = configuration['auth_token'];
    const workflow = configuration['thread_id'];

    if (!auth || !workflow) {
        return "Ошибка: не удалось найти авторизационные данные. Пожалуйста, войдите в систему.";
    }

        const orderCreated = await orderCreate(workflow, auth);
        
        if (orderCreated) {
            const order_token = await paymentApply(workflow, auth);
            
            if (order_token) {
                const result = await paymentConfirm(workflow, auth);
                
                if (result) {
                    return `Ваш заказ на сумму ${result.deliveryInfo?.total_price} тенге оформлен по адресу ${result.deliveryInfo?.address}. Прибудет от ${result.deliveryInfo?.startTime} до ${result.deliveryInfo?.endTime}. Для завершения сессии скажите "Хватит"`;
                }
            }
        }
        return "Ошибка при подтверждении оплаты. Попробуйте снова.";

}, {
    name: "confirmPayment",
    description: "Confirm the payment for the order",
    schema: z.object({
        userInput: z.string().describe("User's input for confirming the payment")
    })
});

const tools = [getCartProductsTool, listToCartTool, confirmOrderTool, confirmPaymentTool];


const model = new ChatOllama({
    baseUrl: 'http://127.0.0.1:11434',
    model: "llama3.1:8b",
    temperature: 0,
}).bindTools(tools);

// Функция для вызова модели
async function callModel(state: typeof StateAnnotation.State) {
    const messages = state.messages;
    const response = await model.invoke(messages);
  
    return { messages: [response] };
  }
  
  // Функция для принятия решения, продолжать ли вызов
function shouldContinue(state: typeof StateAnnotation.State) {
    const messages = state.messages;
    const lastMessage = messages[messages.length - 1] as AIMessage;
  
    if (lastMessage.tool_calls?.length) {
      return "tools";
    }
    return "__end__";
  }
  
  // Создание графа
  const graphs = new StateGraph(StateAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", new ToolNode(tools))  // Подключаем наши инструменты
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent");
  
  // Инициализация памяти для сессий
  const checkpointer = new MemorySaver();
  
  // Компиляция графа
  const lang = graphs.compile({ checkpointer });



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
        userSessions[yandexUserId] = await initializeSession();
    }
    const session = userSessions[yandexUserId];

    const savedUsers: Users = (session.savedUsers) ? session.savedUsers : (data.state?.user?.users || {});

    const config = {
        "configurable": {
            "thread_id": session.workflow,
            "auth_token": session.selectedUser?.auth,
        }
    };

    if(session.awaitingProccess){
        if(session.proccessDone){
            session.awaitingProccess = false;
            sendResponse(session, res, data, session.awaitingResponseText, savedUsers);
        } else {
            sendResponse(session, res, data, 'Запрос в обработке, хотите продолжить?', savedUsers);
        }
    }
    else{
        session.proccessDone = false;
        if (session.endingSession) {
            delete userSessions[yandexUserId];
            endResponse(res, data, 'Всего доброго', savedUsers);
        } else {
            if (session.selectedUser && session.selectedUser.auth){
                // Обрабатываем сообщение пользователя через граф
                const proccess = new Promise(async (resolve) => {
                    const finalState = await lang.invoke({ messages: [new HumanMessage(userInput)] }, config);
                    console.log(finalState);
                    console.log('-------------------------------------');
                
                    // Найдем последний ToolMessage в массиве сообщений
                    const lastToolMessage = finalState.messages.reverse().find((message: { constructor: { name: string; }; }) => message.constructor.name === "ToolMessage");
                
                    // Если ToolMessage найден, то берем его content, иначе AIMessage
                    session.awaitingResponseText = lastToolMessage ? lastToolMessage.content : finalState.messages[0].content;
                    resolve(session.awaitingResponseText);
                });
                              
                const responseText = await raceWithTimeout(proccess.finally(() => session.proccessDone = true), 'Запрос в обработке, хотите продолжить?', 2300);
                sendResponse(session, res, data, responseText, savedUsers);
            } else {
                main(data, userInput, session, res, savedUsers);
            }
        }
    }
    
});

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
            responseText = await handleAuthFlow(userInput, session, res, savedUsers);
            session.awaitingResponseText = responseText;
            resolve(responseText);
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


app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
