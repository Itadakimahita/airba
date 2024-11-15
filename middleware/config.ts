import axios from 'axios';

// Retrieves Workflow ID
export async function getWorkflowId(): Promise<string | null> {
    try {
        const response = await axios.post('https://back-stage.airbafresh.kz/api/orders/workflow/actualize/', { city: 1 });
        return response.data.data.uuid;
    } catch (error) {
        console.error('Error retrieving Workflow ID:', error);
        return null;
    }
}
// Retrieves Workflow ID
export async function refreshWorkflowId(old_workflow: string, token: string): Promise<string | null> {
    try {
        const response = await axios.get('https://back-stage.airbafresh.kz/api/orders/workflow/actualize/',{
            headers: { 
                'Authorization': `JWT ${token}`,
                'workflow': old_workflow,
                'Language': 'ru',
            }
        });
        return response.data.data.uuid;
    } catch (error) {
        console.error('Error retrieving Workflow ID:', error);
        return null;
    }
}


export const apiConfig = {
    headers: {
        language: 'ru'
    },
    tokens: {
        accessToken: '',
        refreshToken: ''
    }
};

export const updateTokens = (accessToken: string, refreshToken: string) => {
    apiConfig.tokens.accessToken = accessToken;
    apiConfig.tokens.refreshToken = refreshToken;
};
