import { User, Users } from './user';
import { getWorkflowId } from '../middleware/config'; 

export interface Sessions {
    [userId: string] : Session;
}

export interface Session {
    workflow: string | null;

    savedUsers: Users | null;

    proccessDone: boolean;
    awaitingProccess: boolean;
    awaitingResponseText: string;

    priceOrder: number | null;

    selectedUser: User | null;
    addingAccount: boolean;
    awaitingAuth: boolean;
    awaitingSms: boolean;
    confirmingOrder: boolean;
    paymentOrder: boolean;
    endingSession: boolean;

}

// Initialize a new session with the current user ID
export const initializeSession = async (): Promise<Session> => {
    return {
            workflow: await getWorkflowId(),

            savedUsers: null,

            proccessDone: false,
            awaitingProccess: false,
            awaitingResponseText: '',

            priceOrder: null,

            selectedUser: null,
            addingAccount: false,
            awaitingAuth: false,
            awaitingSms: false,
            confirmingOrder: false,   
            paymentOrder: false,
            endingSession: false,
    };
};

// Utility function to send a response
export const sendResponse = (session: Session, res: any, data: any, text: string, savedUsers: Users): void => {
    if(text === 'Запрос в обработке, хотите продолжить?') session.awaitingProccess = true
    
    res.json({
        response: {
            text: text,
            end_session: false,
        },
        session: data.session,
        user_state_update: {value: null, users: savedUsers},
        version: data.version,
    })
    
};

// Utility function to send a response
export const endResponse = (res: any, data: any, text: string, savedUsers: Users): void => {
    res.json({
        response: {
            text: text,
            end_session: true,
        },
        session: data.session,
        user_state_update: {users: savedUsers},
        version: data.version,
    });
};
