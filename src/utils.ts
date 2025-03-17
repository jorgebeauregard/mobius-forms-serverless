import { HttpResponseInit } from "@azure/functions";


  
export async function createErrorResponse(status: number, error: string): Promise<HttpResponseInit> {
    return {
        status,
        jsonBody: {
            body: {
                error
            }
        }
    };
}