import { getWorkflowId, refreshWorkflowId } from '../middleware/config'; 
import { sequelize, Dialog, DialogState, UserAccount, User, UserDialogState } from '../db';
import { where } from 'sequelize';


export async function initializeSession(yandexId: string) {
    const transaction = await sequelize.transaction();
    try {
      let userAccount = await UserAccount.findOne({ where: { yandex_id: yandexId } }) as any;
  
      if (!userAccount) {
        const workflowId = await getWorkflowId();
        userAccount = await UserAccount.create({
          yandex_id: yandexId,
          status: 'в процессе',
          last_response: '',
          workflow_id: workflowId,
          response_refreshed: false,
        }, { transaction }) as any;
  
        // Ensure the auth dialog with its specific state
        let authDialog = await Dialog.findOne({ where: { type: 'auth' } }) as any;
        if (!authDialog) {
          authDialog = await Dialog.create({ type: 'auth' }, { transaction }) as any;
        }
  
        // Step 1 for auth: 'addingUser'
        let authDialogState = await DialogState.findOne({
          where: { dialog_id: authDialog.id, step: 1, step_name: 'addingUser' },
        }) as any;
        if (!authDialogState) {
          authDialogState = await DialogState.create({
            dialog_id: authDialog.id,
            step: 1,
            step_name: 'addingUser',
            function_call: 'handleAuthFlow',
          }, { transaction }) as any;
        }
  
        // Create UserDialogState for auth dialog
        await UserDialogState.create({
          user_account_id: userAccount.id,
          dialog_id: authDialog.id,
          dialog_state_id: authDialogState.id,
          step: 1,
        }, { transaction });
  
        // Ensure the main dialog with its specific state
        let mainDialog = await Dialog.findOne({ where: { type: 'main' } }) as any;
        if (!mainDialog) {
          mainDialog = await Dialog.create({ type: 'main' }, { transaction }) as any;
        }
  
        // Step 1 for main: 'listToCart'
        let mainDialogState = await DialogState.findOne({
          where: { dialog_id: mainDialog.id, step: 1, step_name: 'listToCart' },
        }) as any;
        if (!mainDialogState) {
          mainDialogState = await DialogState.create({
            dialog_id: mainDialog.id,
            step: 1,
            step_name: 'listToCart',
            function_call: 'listToCartTool',
          }, { transaction }) as any;
        }
  
        // Create UserDialogState for main dialog
        await UserDialogState.create({
          user_account_id: userAccount.id,
          dialog_id: mainDialog.id,
          dialog_state_id: mainDialogState.id,
          step: 1,
        }, { transaction });
      } else {
        // await User.update({confirm: false, active: false}, {where: {user_account_id: userAccount.id}, transaction});
        // If the user exists, update their session information
        await userAccount.update({ last_session_date: Date.now(), updated_date: Date.now() });
      }
  
      await transaction.commit();
      return userAccount;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  
// Function to create a new user and associate it with an existing UserAccount
export async function createUserWithAccount(userAccountId: any, name: string, number: string) {
    try {
      const newUser = await User.create({
        name,
        number,
        user_account_id: userAccountId,
      }) as any;
  
  
      return newUser;
    } catch (error) {
      console.error('Error creating user with account:', error);
      throw error;
    }
  }
  


// Function to find an existing User by name and number, related to a UserAccount
export async function findUserByAccount(userAccountId: any, name: string) {
  try {
    const user = await User.findOne({
      where: { name: name, user_account_id: userAccountId, },
    });

    return user;
  } catch (error) {
    console.error('Error finding user by account:', error);
    throw error;
  }
}

export const sendResponse = async (res: any, data: any, text: string, userAccount: any): Promise<void> => {
    if(text === 'Запрос в обработке, хотите продолжить?') await userAccount.update({status: 'в ожидании'});

    
    res.json({
        response: {
            text: text,
            end_session: false,
        },
        session: data.session,
        // user_state_update: {value: null, users: savedUsers},
        version: data.version,
    })
    
};

export const endResponse = (res: any, data: any, text: string): void => {
    res.json({
        response: {
            text: text,
            end_session: true,
        },
        session: data.session,
        // user_state_update: {users: savedUsers},
        version: data.version,
    });
};
