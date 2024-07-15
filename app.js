const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const serveStatic = require('serve-static');

const app = express();

app.use(bodyParser.json());

let users = {1: 'слово', 2: 'ключ'}; //список с ключами пользователей по айди
let shoppingLists = {
    1: ['макароны', 'продукты'], 
    2: ['напитки', 'еда', 'вечеринка', 'гости'],
    "F254EB2A5D50E77698F978EC5BFD3B134CD784F223B0A0D2FBBBA8BD41A1ED2F": ['макароны', 'продукты', 'напитки'],
}; // Лист со списком юзера
let userSessions = {}; // Сессии пользователей
let newProducts = [
    {name: 'яблоки', description: 'сочный плод яблони, который употребляется в пищу в свежем и запеченном виде, служит сырьём в кулинарии и для приготовления напитков.'},
    {name: 'груши', description: 'род плодовых и декоративных деревьев и кустарников семейства розовые (Rosaceae), а также их плод.'}
]; // Корзина из списков для пользователя



app.post('/webhook', (req, res) => {
    const data = req.body;
    const userInput = data.request.command.toLowerCase();
    
    // расскоментить после тестов
    // const userId = data.session.user_id; 

    const userId = 1

    // Инициализация пользовательской сессии, если еще не существует
    if (!userSessions[userId]) {
        userSessions[userId] = {
            authenticated: false,
            shoppingList: [],
            awaitingOrder: false,
            confirmingOrder: false,
            news: {index: 0, status: false},
        };
    }

    const session = userSessions[userId];
    let responseText = "Что вы хотели бы заказать?";

    if(userInput.includes('секретное слово')){
        if(!users[userId]){
            users[userId] = userInput.split(' ').at(-1)
            session.userId = userId // убрать после тестов
            responseText = `Ваше новое секретное слово - ${users[userId]}. Что вы хотели бы заказать?`
            session.authenticated = true
        }
        else{
            responseText = 'Вы уже авторизованы, пожалуйста скажите секретное слово'
        }
    }
    else {
        
        // Если пользователь не аутентифицирован, запросите секретное слово
        if (!session.authenticated) {
            if (authorizeUser(userInput, users)) {
                session.authenticated = true;
                session.userId = authorizeUser(userInput, users);
                responseText = "Вы успешно авторизованы. Что вы хотели бы заказать?";
            } else {
                responseText = "Пожалуйста, подтвердите свою личность секретным словом. Если у вас его нет, укажите его, для этого скажите: \"секретное слово\" и ваш ключ";
            }
        } else {
            if(userInput.includes('завершить')){
                delete userSessions[userId]
                endSession(res, data, 'Вы завершили покупки, приятного вам дня')
                return;
            } else if(userInput.includes('заказ')){
                responseText = `Ваш заказ на данный момент состоит из ${session.shoppingList.join(', ')}. Что-нибудь еще?`
            } else if(userInput.includes('новинки')){
                if(session.news.index === newProducts.length){
                    responseText = `Пока что это все новинки на сегодня. Может хотели бы закать что-нибудь?`;
                    session.news.status = false;
                    session.news.index = 0;
                } else {
                    session.news.status = true
                    responseText = `${newProducts[session.news.index].name} - ${newProducts[session.news.index].description}. \nПосмотреть еще что-нибудь?`
                    session.news.index += 1
                }
                
            } else {
                // Если пользователь аутентифицирован
                if(session.news.status){
                    if(userInput.includes('да')){
                        if (session.news.index === newProducts.length) {
                            responseText = `Пока что это все новинки на сегодня. Может хотели бы закать что-нибудь?`;
                            session.news.status = false;
                            session.news.index = 0;
                        } else {
                            responseText = `${newProducts[session.news.index].name} - ${newProducts[session.news.index].description}. \nПосмотреть еще что-нибудь?`;
                            session.news.index += 1;
                        }
                    } else if(userInput.includes('нет')){
                        session.news.status = false
                        session.news.index = 0
                    } else{
                        responseText = 'Я вас не поняла, пожалуйста повторите'
                    }
                    
                } else if (session.awaitingOrder) {
                    if (userInput.includes('нет') || userInput.includes('хватит') || userInput.includes('достаточно')) {
                        responseText = "Завершить заказ?";
                        session.awaitingOrder = false;
                        session.confirmingOrder = true;
                    } else {
                        const listName = userInput.split(' ').at(-1)
                        if (shoppingLists[session.userId] && shoppingLists[session.userId].includes(listName)) {
                            session.shoppingList.push(listName);
                            session.awaitingOrder = true;
                            responseText = "Что-нибудь еще?";
                        } else {
                            responseText = "Данного списка не существует. Может быть какой-нибудь другой? Для просмотра вашего заказа скажите \"заказ\"";
                        }
                    }
                } else if (session.confirmingOrder) {
                    if (userInput.includes('да')) {
                        responseText = `Ваш заказ на ${session.shoppingList.join(', ')} оформлен. Пожалуйста, оплатите заказ. Для завершения сессии скажите \"завершить\"`;
                        // placeOrder(session.shoppingList) // Реализация реального оформления заказа
                        session.shoppingList = [];
                        session.confirmingOrder = false;
                    } else if(userInput.includes('нет') || userInput.includes('отмен')){
                        responseText = "Заказ отменен. Хотели бы вы заказать что-нибудь скажите название списка. Для завершения сессии скажите \"завершить\"";
                        session.confirmingOrder = false;
                        session.shoppingList = [];
                    } else{
                        responseText = "Я вас не поняла. Повторите"
                    }
                } else {
                    const listName = userInput.split(' ').at(-1)
                    if (shoppingLists[session.userId] && shoppingLists[session.userId].includes(listName)) {
                        session.shoppingList.push(listName);
                        session.awaitingOrder = true;
                        responseText = "Что-нибудь еще?";
                    } else {
                        responseText = "Данного списка не существует. Может быть какой-нибудь другой? Для просмотра вашего заказа скажите \"заказ\"";
                    }
                }
            }
        }
    }

    sendResponse(res, data, responseText);
});

function sendResponse(res, data, responseText) {
    res.json({
        response: {
            text: responseText,
            end_session: false
        },
        session: data.session,
        version: data.version
    });
}

function endSession(res, data, responseText) {
    res.json({
        response: {
            text: responseText,
            end_session: true
        },
        session: data.session,
        version: data.version
    });
}

// Функция для авторизации
function authorizeUser(word, users) {
    for(let [k,v] of Object.entries(users)){
        if(v === word) return k
    }
    return null
}

// Функция для оформления заказа через ваше приложение
function placeOrder(items) {
    return axios.post('https://api.yourapp.com/order', { items })
        .then(response => response.status === 200)
        .catch(() => false);
}

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
