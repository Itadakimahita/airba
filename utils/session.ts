import { User, Users } from './user';
import { getWorkflowId } from '../middleware/config'; 

export interface Sessions {
    [userId: string] : Session;
}

export interface Session {
    workflow: Promise<string | null>,
    selectedUser: User | null;
    addingAccount: boolean;
    awaitingAuth: boolean;
    awaitingSms: boolean;
    confirmingOrder: boolean;
    paymentOrder: boolean;
    endingSession: boolean;
}

// Initialize a new session with the current user ID
export const initializeSession = (): Session => {
    return {
            workflow: getWorkflowId(),
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
export const sendResponse = (res: any, data: any, text: string, savedUsers: Users): void => {
    res.json({
        response: {
            text: text,
            end_session: false,
        },
        session: data.session,
        user_state_update: {users: savedUsers},
        version: data.version,
    });
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
