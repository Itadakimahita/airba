const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const serveStatic = require('serve-static');
const cookieParser = require('cookie-parser');

const app = express();

app.use(bodyParser.json());
app.use(cookieParser());

let users = {
    "1": [{name: "диас", number: "87775555355"}, {name: "дима", number: "87775555555"}], //yandexId : [name, number, authStatus]
    "2": [{name: "john", number: "87775555555"}],
};

let shoppingLists = {
    "87474816309": ['макароны', 'продукты', 'напитки', 'гости'],
};

let userSessions = {};
let newProducts = [
    {name: 'яблоки', description: 'сочный плод яблони, который употребляется в пищу в свежем и запеченном виде, служит сырьём в кулинарии и для приготовления напитков.'},
    {name: 'груши', description: 'род плодовых и декоративных деревьев и кустарников семейства розовые (Rosaceae), а также их плод.'}
];

app.post('/webhook', (req, res) => {
    const data = req.body;
    const userInput = data.request.command.toLowerCase();
    const yandexUserId = data.session.user_id;
    const cookies = req.cookies;

    // Initialize session if not exists
    if (!userSessions[yandexUserId]) {
        userSessions[yandexUserId] = {
            accountSession: users[yandexUserId], //getting yandex account users
            selectedUser: null, //user selecting of yandex account
            awaitingAuth: false, //check auth
            awaitingSms: false,
            addingAccount: false, //adding new user to session
            awaitingOrder: false, //making order
            confirmingOrder: false, //ending order
            shoppingList: [],
            news: {index: 0, status: false}, //for news
        };
    }



    const session = userSessions[yandexUserId];
    let responseText = "Что вы хотели бы сделать?";

    if(session.selectedUser ? session.selectedUser.auth : false) {
        if (userInput.includes('завершить')) {
            delete userSessions[yandexUserId];
            endSession(res, data, 'Вы завершили покупки, приятного вам дня');
            return;
        } else if (userInput.includes('корзина')) {
            responseText = session.shoppingList ? 
            `Ваша корзина на данный момент состоит из ${session.shoppingList.join(', ')}. Что-нибудь еще?`
             : 'Ваша корзина на данный момент пустая';
        } else if (userInput.includes('новинки')) {
            if (session.news.index === newProducts.length) {
                responseText = `Пока что это все новинки на сегодня. Может быть, вы хотели бы заказать что-нибудь?`;
                session.news.status = false;
                session.news.index = 0;
            } else {
                session.news.status = true;
                responseText = `${newProducts[session.news.index].name} - ${newProducts[session.news.index].description}. \nПосмотреть еще что-нибудь?`;
                session.news.index += 1;
            }
        } else {
            if (session.news.status) {
                if (userInput.includes('да')) {
                    if (session.news.index === newProducts.length) {
                        responseText = `Пока что это все новинки на сегодня. Может быть, вы хотели бы заказать что-нибудь?`;
                        session.news.status = false;
                        session.news.index = 0;
                    } else {
                        responseText = `${newProducts[session.news.index].name} - ${newProducts[session.news.index].description}. \nПосмотреть еще что-нибудь?`;
                        session.news.index += 1;
                    }
                } else if (userInput.includes('нет')) {
                    session.news.status = false;
                    session.news.index = 0;
                } else {
                    responseText = 'Я вас не поняла, пожалуйста, повторите.';
                }
            } else if (session.awaitingOrder) {
                if (userInput.includes('нет') || userInput.includes('хватит') || userInput.includes('достаточно')) {
                    responseText = "Завершить заказ?";
                    session.awaitingOrder = false;
                    session.confirmingOrder = true;
                } else {
                    const listName = userInput.split(' ').at(-1);
                    if (shoppingLists[session.selectedUser.number] && shoppingLists[session.selectedUser.number].includes(listName)) {
                        session.shoppingList.push(listName);
                        session.awaitingOrder = true;
                        responseText = "Что-нибудь еще?";
                    } else {
                        responseText = "Данного списка не существует. Может быть какой-нибудь другой? Для просмотра вашего заказа скажите \"корзина\"";
                    }
                }
            } else if (session.confirmingOrder) {
                if (userInput.includes('да')) {
                    responseText = `Ваш заказ на ${session.shoppingList.join(', ')} оформлен. Пожалуйста, оплатите заказ. Для завершения сессии скажите \"завершить\"`;
                    session.shoppingList = [];
                    session.confirmingOrder = false;
                } else if (userInput.includes('нет') || userInput.includes('отмен')) {
                    responseText = "Заказ отменен. Хотели бы вы заказать что-нибудь? Если да, скажите название списка. Для завершения сессии скажите \"завершить\"";
                    session.confirmingOrder = false;
                    session.shoppingList = [];
                } else {
                    responseText = "Я вас не поняла. Повторите, пожалуйста.";
                }
            } else {
                const listName = userInput.split(' ').at(-1);
                if (shoppingLists[session.selectedUser.number] && shoppingLists[session.selectedUser.number].includes(listName)) {
                    session.shoppingList.push(listName);
                    session.awaitingOrder = true;
                    responseText = "Что-нибудь еще?";
                } else {
                    responseText = "Данного списка не существует. Может быть какой-нибудь другой? Для просмотра вашего заказа скажите \"корзина\"";
                }
            }
        }
    }
    
    //adding new user
    if(userInput.includes('новый')){
        responseText = 'Для добавления нового пользователя, назовите свое имя и номер телефона'
        session.addingAccount = true
        session.awaitingAuth = false
    } else if(userInput.includes('отмена')){
        session.addingAccount = false
    } else if(session.addingAccount){
        const [name, number] = extractNameAndNumber(userInput);
        if (name && number) {
            users[yandexUserId] = users[yandexUserId] || [];
            users[yandexUserId].push({name: name, number: number});
            session.accountSession = users[yandexUserId]
            
            responseText = `Пользователь ${name} добавлен. Пожалуйста, выберите пользователя, сказав его имя, например: ${session.accountSession.map(user => user.name).join(', ')}.`;
            session.addingAccount = false;
            session.awaitingAuth = true
        } else {
            responseText = "Пожалуйста, добавьте пользователя сказав: ваше имя, номер затем продиктуйте ваш номер. Или же скжаите \"Отмена\"";
        }
    } else {
        if(!session.accountSession){
            responseText = "Вы еще не добавили пользователей. Назовите свое имя и номер телефона для добавления.";
            session.addingAccount = true;
        } else if (session.awaitingAuth) {
            if(session.awaitingSms){
                if(verifySms(session.selectedUser.number, userInput)){ // Подтверждение по смс позже заменить на готовый метод
                    responseText = "Вы успешно авторизованы. Что вы хотели бы заказать?";
                    session.selectedUser.auth = true
                    refreshCookie(res, session.selectedUser.number);  // Refresh the cookie
                    session.awaitingSms = false
                    session.awaitingAuth = false
                } else {
                    responseText = 'Неверный код'
                }
            } else{
                const number = getNumberByName(userInput, session.accountSession)
                if(number){
                    session.selectedUser = {name: userInput, number: number, auth: false}
                    console.log(session.selectedUser)
                    if(!cookies[`${number}_auth`]){
                        responseText = `Для подтверждения авторизации пользователя ${userInput} отправлено SMS. Пожалуйста, скажите код.`;
                        sendSMSAuthorization(session.selectedUser.number);  // Implement SMS sending logic here

                        session.awaitingSms = true;
                    } else {
                        responseText = "Вы успешно авторизованы. Что вы бы хотели заказать?";
                        session.selectedUser.auth = true
                        refreshCookie(res, session.selectedUser.number);  // Refresh the cookie
                    }
                } else {
                    responseText = 'Данного имени не существуют'
                }
            }
            
        }  else {
            // If no user is selected, ask to select or add one
            if (!session.selectedUser) {
                responseText = `У вас есть несколько пользователей. Пожалуйста, выберите кого-то, сказав его имя, например: ${session.accountSession.map(user => user.name).join(', ')}. Или для добавление нового скажите: "новый пользователь"`;
                session.awaitingAuth = true
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

function refreshCookie(res, number) {
    res.cookie(`${number}_auth`, true, {maxAge: 86400000}); // 1 day expiration
}

async function sendSMSAuthorization(number) {
    try {
        const response = await axios.post('https://back-stage.airbafresh.kz/api/v1/auth/signin/', {
            mobile_phone: number
        }, {
            headers: {
                'Workflow': 'e2d55565-618b-4668-b9c4-2171e52f055e',
                'language': 'ru'
            }
        });

        if (response.status === 200) {
            console.log('OTP отправлен успешно');
        } else {
            console.error('Ошибка при отправке OTP:', response.data);
        }
    } catch (error) {
        console.error('Ошибка при отправке запроса:', error);
    }
}


async function verifySms(number, sms) {
    try {
        const response = await axios.post('https://back-stage.airbafresh.kz/api/v1/auth/otp-verify/', {
            mobile_phone: number,
            otp: sms
        }, {
            headers: {
                'Workflow': 'e2d55565-618b-4668-b9c4-2171e52f055e',
                'language': 'ru'
            }
        });

        if (response.status === 200) {
            console.log('OTP отправлен успешно');
        } else {
            console.error('Ошибка при отправке OTP:', response.data);
        }
    } catch (error) {
        console.error('Ошибка при отправке запроса:', error);
    }
}


function extractNameAndNumber(input) {
    // Regular expression to match the name (assuming the name is the first part of the string)
    const nameMatch = input.match(/^[^\d]+/);
    const name = nameMatch ? nameMatch[0].trim() : "";

    // Regular expression to match and clean the phone number
    const phoneMatch = input.match(/[\d\+\-\(\)\s]+/);
    let phoneNumber = phoneMatch ? phoneMatch[0] : "";

    // Remove all non-digit characters
    phoneNumber = phoneNumber.replace(/\D/g, "");

    // Replace starting 8 with +7
    if (phoneNumber.startsWith("8")) {
        phoneNumber = "+7" + phoneNumber.substring(1);
    } else if (!phoneNumber.startsWith("+")) {
        phoneNumber = "+" + phoneNumber;
    }

    return [name, phoneNumber]

}

function getNumberByName(name, users){
    const user = users.find(user => user.name.toLowerCase() === name.toLowerCase())
    return user ? user.number : null;
}


app.listen(3000, () => {
    console.log('Server is running on port 3000');
});


