import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from "@azure/storage-blob";
import { v4 as uuidv4 } from 'uuid';

export async function uploadImages(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    try {
        const formData = await req.formData();
        const files = formData.getAll('files');
        
        if (!files.length) {
            return { status: 400, body: "No files uploaded" };
        }

        const uploadPromises = files.map(async (file) => {
            if (!(file instanceof Blob)) {
                throw new Error("Invalid file type");
            }

            // Get file extension from Blob type
            const fileName = (file as unknown as { name: string }).name;
            const fileExtension = fileName.substring(fileName.lastIndexOf('.'));

            // Generate short unique name
            const blobName = `${uuidv4().replace(/-/g, '').slice(0, 12)}${fileExtension}`;

            // Connect to blob storage
            const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
            const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_STORAGE_CONTAINER_NAME);
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            // Upload file
            const arrayBuffer = await file.arrayBuffer();
            await blockBlobClient.uploadData(arrayBuffer);

            return blockBlobClient.url;
        });

        const urls = await Promise.all(uploadPromises);

        return {
            status: 200,
            jsonBody: {
                urls
            }
        };
    } catch (error) {
        context.log('Error uploading images:', error);
        return { status: 500, body: "Failed to upload images" };
    }
}

app.http('uploadImages', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: uploadImages
});