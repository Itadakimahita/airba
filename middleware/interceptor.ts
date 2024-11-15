import axios from 'axios';
import { apiConfig } from './config';

// Set up Axios instance
const apiClient = axios.create({
    baseURL: 'https://back-stage.airbafresh.kz',
    timeout: 15000,
});

// Add a request interceptor to inject headers
apiClient.interceptors.request.use(
    (config) => {
        // config.headers['Authorization'] = `Bearer ${apiConfig.accessToken}`;
        config.headers['language'] = apiConfig.headers.language;

        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// Optional: Add a response interceptor (for example, to handle token refresh)
apiClient.interceptors.response.use(
    (response) => {
        return response;
    },
    // async (error) => {
    //     // Handle 401 errors (e.g., refresh token flow)
    //     if (error.response.status === 401 && apiConfig.tokens.refreshToken) {
    //         try {
    //             // Attempt to refresh the token using the refreshToken
    //             const response = await axios.post('https://your-api-url.com/refresh', {
    //                 token: apiConfig.tokens.refreshToken,
    //             });

    //             // Update tokens in apiConfig
    //             apiConfig.accessToken = response.data.accessToken;
    //             apiConfig.refreshToken = response.data.refreshToken;

    //             // Retry the original request with the new access token
    //             error.config.headers['Authorization'] = `Bearer ${apiConfig.accessToken}`;
    //             return axios(error.config);
    //         } catch (refreshError) {
    //             return Promise.reject(refreshError);
    //         }
    //     }

    //     return Promise.reject(error);
    // }
);

export default apiClient;

