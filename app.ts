import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import serveStatic from 'serve-static';


import { sendSMSAuthorization, verifySms, getLists, refreshToken } from './api/auth';
import { getNumberByName, extractNameAndNumber } from './utils/user';
import { initializeSession, sendResponse, endResponse, createUserWithAccount, findUserByAccount, waitingResponse } from './utils/session';
import { apiConfig, updateTokens, refreshWorkflowId } from './middleware/config';  // Import the config and token update functions
import { checkProducts, getCartProducts, listToCart } from './api/cart';
import { closestTimeSlot, orderCreate, paymentCards, workflowCheckout } from './api/order';
import { paymentApply, paymentConfirm } from './api/payment';

import { sequelize, Dialog, DialogState, UserAccount, User, UserDialogState } from './db';
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { StateGraph } from "@langchain/langgraph";
import { MemorySaver, Annotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatOllama } from '@langchain/ollama';

import { getWorkflowId } from './middleware/config';

import { CallbackHandler } from "langfuse-langchain";

require('dotenv').config();


const StateAnnotation = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
      reducer: (x, y) => x.concat(y),
    }),
    which: Annotation<string>({
        reducer: (x: string, y: string) => (y ?? x),
    })
})

const changeUser = tool(async ({userInput}, config) => {
    const configuration = config['configurable'];
    const userAccount = configuration['userAccount'];
    const activeUser = configuration['activeUser'];
    let responseText = '';

    await User.update({active: false, confirmed: false}, {where: {id: activeUser.id}});
    
    const dialog = await Dialog.findOne({ where: { type: 'auth' } }) as any; 
    const userDialogState = await UserDialogState.findOne({ where: { user_account_id: userAccount.id, dialog_id: dialog.id } }) as any;
    const associatedUsers = await User.findAll({ where: { user_account_id: userAccount.id } }) as any;
    const matchingUser = associatedUsers.find((user: any) =>
        userInput.toLowerCase().includes(user.name.toLowerCase())
    );
    const nextState = await DialogState.findOne({ where: { step: 2, dialog_id: dialog.id } }) as any;
    await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
    if(matchingUser){
        responseText = await handleAuthFlow(matchingUser, userAccount);
    } else {
        responseText = await handleAuthFlow('', userAccount);
    }

    return responseText;
}, {
    name: "changeActiveUser",
    description: "Пользователь хочет поменять свой аккаунт по имени",
    schema: z.object({
        userInput: z.string().describe('Получает имя пользователя на которого он хочет сменить')
    }),
});


const helpInstruction = tool(async ({}, config) => {
    let responseText = `Для того чтобы заказть продукты, пожалуйста скажите название вашего списка, так же вы можете сменить пользователя.`

    return responseText;
}, {
    name: "helpInstruction",
    description: "Инструкция пользователю",
});

// Добавляем другие инструменты для корзины и продуктов
const getCartProductsTool = tool(async ({}, config) => {
    const configuration = config['configurable'];
    const workflow = configuration['userAccount'].workflow_id;
    const responseText = 'Ваш заказ на ' + (await getCartProducts(workflow)).join(', ') + ' хотели бы заказать что-нибудь еще?';
    return responseText;
}, {
    name: "getCartProducts",
    description: "Пользователь запрашивает псмотреть его корзину или заказ"
});

const listToCartTool = tool(async ({ userInput }, config) => {
    // Проверяем, есть ли auth и workflow в сессии
    const configuration = config['configurable'];
    const userAccount = configuration['userAccount']
    const workflow = configuration['userAccount'].workflow_id;
    const auth = configuration['activeUser'].auth_token;

    if (!auth || !workflow) {
        return "Ошибка: не удалось найти авторизационные данные. Пожалуйста, войдите в систему.";
    }

    // Find or create the 'main' dialog
    const [dialog] = await Dialog.findOrCreate({
        where: { type: 'main' },
    }) as any;

  // Find the DialogState for step 1 in the 'main' dialog
    const dialogState = await DialogState.findOne({
        where: { dialog_id: dialog.id, step: 1 },
    }) as any;

  // Upsert the UserDialogState to reflect step 1 for this user
    await UserDialogState.upsert({
        user_account_id: userAccount.id, 
        dialog_id: dialog.id,
        dialog_state_id: dialogState?.id,
        step: 1,
  });

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
    description: "Добавить список продуктов в корзину или заказ",
    schema: z.object({
        userInput: z.string().describe("Передай сообщение пользователя без изменений")
    }),
});

const confirmOrderTool = tool(async ({ userInput }, config) => {
    const configuration = config['configurable'];
    const userAccount = configuration['userAccount'];
    const auth = configuration['activeUser'].auth_token;
    const workflow = userAccount.workflow_id;

    // Find or create the 'main' dialog
    const [dialog] = await Dialog.findOrCreate({
        where: { type: 'main' },
    }) as any;

    // Find the DialogState for step 1 in the 'main' dialog
    const dialogState = await DialogState.findOne({
        where: { dialog_id: dialog.id, step: 2 },
    }) as any;

    

    if (!auth || !workflow) {
        return "Ошибка: не удалось найти авторизационные данные. Пожалуйста, войдите в систему.";
    }

        const payment_card = await paymentCards(auth, workflow);
        const timeslot = await closestTimeSlot(workflow);
        
        if (payment_card && timeslot) {
            const price = await workflowCheckout(workflow, auth, timeslot, payment_card);
            // Upsert the UserDialogState to reflect step 1 for this user
            await UserDialogState.upsert({
                user_account_id: userAccount.id, 
                dialog_id: dialog.id,
                dialog_state_id: dialogState?.id,
                step: 2,
            });
            return `Оплатить заказ на сумму ${price ? price : 'ошибка'} тенге?`;
        } else {
            return "Скорее всего у вас нет выбранной карты в приложении, пожалуйста подключите способ оплаты";
        }
}, {
    name: "confirmOrder",
    description: "Подтверить заказ или оформить корзину так же пользователь может сказать \"нет\" после добавления списка продуктов в корзину чтобы перейти к оформлению",
    schema: z.object({
        userInput: z.string().describe("User's input for confirming the order")
    })
});
const confirmPaymentTool = tool(async ({ userInput }, config) => {
    const configuration = config['configurable'];
    const userAccount = configuration['userAccount'];
    const auth = configuration['activeUser'].auth_token;
    const workflow = userAccount.workflow_id;
  
    // Find or create the 'main' dialog
    const [dialog] = await Dialog.findOrCreate({
      where: { type: 'main' },
    }) as any;
    console.log(dialog);
    
  
    // Find the DialogState for step 3 in the 'main' dialog
    const dialogStateStep3 = await DialogState.findOne({
      where: { dialog_id: dialog.id, step: 3 },
    }) as any;
  
    // Retrieve the UserDialogState entry for the user and dialog
    const userDialogState = await UserDialogState.findOne({
      where: {
        user_account_id: userAccount.id,
        dialog_id: dialog.id,
      },
    }) as any;
  
    // Check if the user's current step is 2 before proceeding
    if (!userDialogState || userDialogState.step !== 2) {
      return "Ошибка: пожалуйста, подтвердите заказ перед оплатой.";
    }

    if (!auth || !workflow) {
      return "Ошибка: не удалось найти авторизационные данные. Пожалуйста, войдите в систему.";
    }
  
    const orderCreated = await orderCreate(workflow, auth);
  
    if (orderCreated) {
      const order_token = await paymentApply(workflow, auth);
  
      if (order_token) {
        const result = await paymentConfirm(workflow, auth);
  
        if (result) {
          // Update the UserDialogState to step 3 after successful payment
          await UserDialogState.upsert({
            user_account_id: userAccount.id,
            dialog_id: dialog.id,
            dialog_state_id: dialogStateStep3?.id,
            step: 3,
          });

          await userAccount.update({workflow_id: result.workflowUUID});

          return `Ваш заказ на сумму ${result.deliveryInfo?.total_price} тенге оформлен по адресу ${result.deliveryInfo?.address}. Прибудет от ${result.deliveryInfo?.startTime} до ${result.deliveryInfo?.endTime}. Для завершения сессии скажите "Хватит"`;

        }
      }
    }
  
    return "Ошибка при подтверждении оплаты. Попробуйте снова.";
  }, {
    name: "confirmPayment",
    description: "Подтверждение оплаты вызывается когда пользователь уже подтвердил заказ, он может сказать \"да\" для оплаты",
    schema: z.object({
      userInput: z.string().describe("User's input for confirming the payment, it should be some confirm message after order")
    })
  });
  
const tools = [getCartProductsTool, listToCartTool, confirmOrderTool, confirmPaymentTool, changeUser, helpInstruction];

const langfuseHandler = new CallbackHandler({
    publicKey: process.env.PUBLIC_LANGFUSE_API_KEY,
    secretKey: process.env.LANGFUSE_API_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
});

const model = new ChatOllama({
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.LLM,
    temperature: 0,
    callbacks: [langfuseHandler],
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

// export let userSessions: Sessions = {};

app.post('/webhook', async (req: Request, res: Response) => {
    const data = req.body;
    const userInput = data.request.command.toLowerCase();
    const yandexUserId = data.session.user_id;
    
    let currentUser = await initializeSession(yandexUserId) as any;
    
    // const session = userSessions[yandexUserId];

    // const savedUsers = (session.savedUsers) ? session.savedUsers : (data.state?.user?.users || {});

    if(currentUser.status === 'в ожидании'){
        if(currentUser.response_refreshed){
            await currentUser.update({status: 'в процессе'});
            await sendResponse(res, data, currentUser.last_response, currentUser);
        } else {
            await sendResponse(res, data, waitingResponse, currentUser);
        }
    }
    else{
        await currentUser.update({response_refreshed: false});
        if (currentUser.status === 'завершен') {
            endResponse(res, data, 'Всего доброго');
        } else { 
            main(data, userInput, currentUser, res, yandexUserId);
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


async function main(data: any, userInput: string, currentUser: any, res: Response, yandexUserId: string) {
    let responseText = '';

    const entireProcessPromise = new Promise(async (resolve) => {
            
        const user = await User.findOne({where: {user_account_id: currentUser.id, active: true, confirmed: true}}) as any;
        if(user){
            
            const new_token = await refreshToken(user.refresh_token, user.auth_token);

            if(!new_token){
                console.log(user);
                
                const dialog = await Dialog.findOne({ where: { type: 'auth' } }) as any; 
                const userDialogState = await UserDialogState.findOne({ where: { user_account_id: currentUser.id, dialog_id: dialog.id } }) as any;
                const nextState = await DialogState.findOne({ where: { step: 2, dialog_id: dialog.id } }) as any;
                await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
                await user.update({active: false, confirmed: false, auth_token: null, refresh_token: null});
                const response = await handleAuthFlow(userInput, currentUser);
                await currentUser.update({last_response: response})
                resolve(currentUser.last_response);
            }
            else{
                await user.update({auth_token: new_token});
                const workflow_actualized = await refreshWorkflowId(currentUser.workflow_id, user.auth_token);
                if(workflow_actualized){
                    await currentUser.update({workflow_id: workflow_actualized});
                }
               const config = {
                    "configurable": {
                        "thread_id": yandexUserId,
                        "callbacks": [langfuseHandler],
                        "userAccount": currentUser,
                        "activeUser": user,
                    }
                };
                    // Обрабатываем сообщение пользователя через граф
            
                const finalState = await lang.invoke({ messages: [new HumanMessage(userInput)] }, config);
                console.log(finalState);
                console.log('-------------------------------------');
                
                    // Найдем последний ToolMessage в массиве сообщений
                const lastToolMessage = finalState.messages.reverse().find((message: { constructor: { name: string; }; }) => message.constructor.name === "ToolMessage");
            
                // Если ToolMessage найден, то берем его content, иначе AIMessage
                await currentUser.update({last_response: lastToolMessage ? lastToolMessage.content : finalState.messages[0].content});
                resolve(currentUser.last_response);
            }
        } else {
            const response = await handleAuthFlow(userInput, currentUser)
            await currentUser.update({last_response: response});
            resolve(currentUser.last_response);
        }
    });

    // Используем Promise.race для отслеживания общего времени выполнения
    responseText = await raceWithTimeout(entireProcessPromise.finally(async () => await currentUser.update({response_refreshed: true})), waitingResponse, 2300);
    await sendResponse(res, data, responseText, currentUser);
}

async function handleAuthFlow(userInput: string, userAccount: any) {
    let responseText = "";
  
    // Get the current UserDialogState
    const dialog = await Dialog.findOne({ where: { type: 'auth' } }) as any; 
    const userDialogState = await UserDialogState.findOne({ where: { user_account_id: userAccount.id, dialog_id: dialog.id } }) as any;
    
    const associatedUsers = await User.findAll({ where: { user_account_id: userAccount.id } }) as any;

    

    
    if(userInput.includes('помощь') || userInput.includes('умеешь')){
        responseText = 'Авторизуйтесь для того чтобы заказать продукты, для этого скажите название нужного вам списка';
    } 
    else{
        // Step 1: Adding a New User
        if (userInput.includes('новый')) {
            const nextState = await DialogState.findOne({ where: { step: 1, dialog_id: dialog.id } }) as any;
            await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
            responseText = 'Пожалуйста добавьте пользователя, для этого скажите имя и номер телефона';
        } else if (userDialogState.step === 1) {
            const [name, number] = extractNameAndNumber(userInput);
            if (name && number) {
                const newUser = await createUserWithAccount(userAccount.id, name, number);
                console.log(newUser);
                if(newUser){
                    responseText = `Пользователь ${name} добавлен. Выберите пользователя, сказав его имя.`;
                
                    // Set to Step 2 - Selecting User
                    const nextState = await DialogState.findOne({ where: { step: 2, dialog_id: dialog.id } }) as any;
                    await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
                }
                
                
            } else if (associatedUsers.length === 0) {
                // No users found, prompt to add a new user and set state to Step 1 (addingUser)
                responseText = "Добавьте нового пользователя сказав имя и номер телефона";
            
                const initialState = await DialogState.findOne({ where: { step: 1, dialog_id: dialog.id } }) as any;
                await userDialogState.update({ dialog_state_id: initialState.id, step: initialState.step });
            } else {
            responseText = "Ошибка добавления пользователя. Пожалуйста, повторите.";
            }
        }
    
        // Step 2: Selecting User
        else if (userDialogState.step === 2) {
            const user = await findUserByAccount(userAccount.id, userInput) as any;
            if (user) {
                await user.update({active: true});
                if (user.auth_token && user.refresh_token) {
                    const newToken = await refreshToken(user.auth_token, user.refresh_token);
                    if (newToken) {
                        await user.update({ auth_token: newToken, active: true });
                        responseText = "Авторизация успешна. Теперь вы можете запросить новинки или добавить продукты в корзину.";
                    } else {
                        await sendSMSAuthorization(user.number, userAccount.workflow_id);
                        responseText = `Для пользователя ${user.name} отправлено SMS. Скажите код.`;

                        // Set to Step 4 - Awaiting OTP
                        const nextState = await DialogState.findOne({ where: { step: 4, dialog_id: dialog.id } }) as any;
                        await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
                        }
                } else {
                    
                    await sendSMSAuthorization(user.number, userAccount.workflow_id);
                    responseText = `Для пользователя ${user.name} отправлено SMS. Скажите код.`;

                    // Set to Step 4 - Awaiting OTP
                    const nextState = await DialogState.findOne({ where: { step: 4, dialog_id: dialog.id } }) as any;
                    await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
                }
            } else {
                responseText = 'Выберите пользователя из существующих: ' + associatedUsers.map((user: { name: any; }) => user.name).join(', ');

            }
        }
    
        // Step 4: Awaiting OTP Verification
        else if (userDialogState.step === 4) {
            const user = await User.findOne({ where: { user_account_id: userAccount.id, active: true } }) as any;
            
            const [accessToken, refreshToken] = await verifySms(user.number, userInput, userAccount.workflow_id);
            if (accessToken && refreshToken) {
                await user.update({ auth_token: accessToken, refresh_token: refreshToken, active: true, confirmed: true });
                const nextState = await DialogState.findOne({ where: { step: 2, dialog_id: dialog.id } }) as any;
                await userDialogState.update({ dialog_state_id: nextState.id, step: nextState.step });
                responseText = "Авторизация успешна. Теперь вы можете запросить новинки или добавить продукты в корзину.";
            } else {
                responseText = "Неверный код. Попробуйте снова.";
            }
        } else {
        responseText = "Неопознанное действие. Попробуйте еще раз.";
        }
    }
    
  
    return responseText;
  }

const db_start = async () => {
    try{
        await sequelize.authenticate()
        // Sync all models with the database
        await sequelize.sync({ force: false })  // Set force to true to reset tables on each run
        .then(() => {
        console.log('Database & tables created!');
        })
        .catch(err => console.error('Error syncing database:', err));
    } catch(e){
        console.log(e);
        
    }
}

app.listen(process.env.PORT, () => { 
    db_start()
    console.log(`Server is running on port ${process.env.PORT}`);
});
