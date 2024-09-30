import apiClient from '../middleware/interceptor';

// Retrieves lists
export async function listToCart(token: string, workflowId: Promise<string | null>, id: number) {
    try {
        const response = await apiClient.post(`/api/personal-lists/list/${id}/cart`, {
        },
        {
            headers: {
                'Authorization': `JWT ${token}`,
                'workflow': await workflowId
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching lists:', error);
        return [];
    }
}
export async function getCartProducts(workflowId: Promise<string | null>): Promise<string[]> {
    try {
        const response = await apiClient.get('/api/orders/cart/v3', {
            headers: { 
                'workflow': await workflowId,
            }
        });

        // Extract the product names
        const products = response.data.data.cart?.flatMap((store: any) =>
            store.sections?.flatMap((section: any) =>
                section.products?.map((product: any) => product.name)
            ) ?? []
        ) ?? [];

        return products;
    } catch (error) {
        console.error('Error fetching cart products:', error);
        return [];
    }
}

export async function checkProducts(workflowId: Promise<string | null>, token: string, id: number): Promise<{ name: string, stockCount: number }[]> {
    try {
        const response = await apiClient.get(`/api/personal-lists/list/${id}`, {
            headers: { 
                'Authorization': `JWT ${token}`,
                'workflow': await workflowId,
            }
        });

        // Extracting product names and stock counts from the response data
        const products = response.data.data?.products?.results.map((product: any) => ({
            name: product.name,
            stockCount: product.stocks_count
        })) || [];

        return products;
    } catch (error) {
        console.error('Error fetching lists:', error);
        return [];
    }
}
