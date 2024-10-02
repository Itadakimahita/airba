import apiClient from '../middleware/interceptor';

//Applying order
export async function paymentApply(workflowId: Promise<string | null>, token: string, ) : Promise<string|null> {
    try {
        const response = await apiClient.post('/api/payments/apply/', {},
        {
            headers: {
                'Authorization': `JWT ${token}`,
                'workflow': await workflowId
            }
        });
        return response.data.data?.order_access_token;
    } catch (error) {
        console.error('Error fetching lists:', error);
        return null;
    }
}



export async function paymentConfirm(workflowId: Promise<string | null>, token: string) : Promise<{
    workflowUUID: string | null,
    deliveryInfo: {
        address: string,
        startTime: string,
        endTime: string,
        total_price: number
    } | null}> {

    try {
        const response = await apiClient.post('/api/payments/confirm/', {}, {
            headers: { 
                'Authorization': `JWT ${token}`,
                'workflow': await workflowId
            }
        });

        // Extract new_workflow UUID
        const workflowUUID = response.data.data?.new_workflow?.uuid ?? null;

        // Extract delivery info
        const deliveryInfo = response.data.data?.delivery_timeslot
            ? {
                address: response.data.data?.address ?? 'No address',
                startTime: response.data.data.delivery_timeslot.start_time,
                endTime: response.data.data.delivery_timeslot.end_time,
                total_price: response.data.data?.new_workflow?.delivery?.total_price ?? 0
            }
            : null;

        // Return the relevant details
        return {
            workflowUUID,
            deliveryInfo
        };
    } catch (error) {
        console.error('Error confirming payment:', error);
        return {
            workflowUUID: null,
            deliveryInfo: null
        };
    }
}

