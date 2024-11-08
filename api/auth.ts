import apiClient from '../middleware/interceptor';

// Sends SMS authorization
export async function sendSMSAuthorization(number: string, workflowId: string | null): Promise<void> {
    try {
        await apiClient.post('/api/v1/auth/signin/', { mobile_phone: number },
            {
                headers: {
                    'workflow': workflowId
                }
            }
        );
        console.log('OTP sent successfully');
    } catch (error) {
        console.error('Error sending OTP:', error);
    }
}

// Verifies OTP
export async function verifySms(number: string, sms: string, workflowId: string | null): Promise<[string | null, string | null]> {
    try {
        // Оставляем только цифры в SMS-коде
        const cleanedSms = sms.replace(/\D/g, '');

        const response = await apiClient.post('/api/v1/auth/otp-verify/', {
            mobile_phone: number,
            otp: cleanedSms,  // Используем очищенный SMS-код
        },
        {
            headers: {
                'workflow': workflowId
            }
        });

        return [response.data.data.access_token, response.data.data.refresh_token];
    } catch (error) {
        console.error('Error verifying OTP:', error);
        return [null, null];
    }
}

// Sends SMS authorization
export async function refreshToken(refresh_token: string, token: string): Promise<string | null> {
    try {
        const response = await apiClient.post('/api/v1/auth/refresh/', {
            refresh: refresh_token,
            old_token: token
        });
        
        return response.data.data.access_token;
    } catch (error) {
        console.log(error);
        
        return null
    }
}

// Retrieves lists
export async function getLists(token: string, workflowId: string | null): Promise<{ id: number, title: string }[]> {
    try {
        const response = await apiClient.get('/api/personal-lists/list', {
            headers: { 
                'Authorization': `JWT ${token}`,
                'workflow': workflowId,
            }
        });
        return response.data.data.map((list: any) => ({ id: list.id, title: list.title }));
    } catch (error) {
        console.error('Error fetching lists:', error);
        return [];
    }
}
