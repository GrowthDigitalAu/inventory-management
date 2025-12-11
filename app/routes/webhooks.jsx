import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { verifyWebhook } from "../verifyWebhooks";

export const loader = async ({ request }) => {
    return new Response("Webhook endpoint is active", { status: 200 });
};


export const action = async ({ request }) => {
    if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
    }

    try {
        // STEP 1: Manual HMAC verification (Required for App Store Review)
        // If the request isn't from Shopify (invalid HMAC), we MUST return 401 Unauthorized.
        const trustworthy = await verifyWebhook(request.clone());
        console.log("TRUSTWORTHY WEBHOOK: %o", trustworthy);

        if (!trustworthy) {
            console.error("❌ Invalid HMAC - Request not from Shopify");
            return new Response("Unauthorized", { status: 401 });
        }

        // Authenticate the webhook request
        const { shop, payload, topic } = await authenticate.webhook(request);

        console.log(`Received ${topic} webhook from ${shop}`);
        console.log("Payload:", JSON.stringify(payload, null, 2));

        switch (topic) {

            case "CUSTOMERS_DATA_REQUEST":
                //Logic for requesting customers data goes here...
                console.log(`📌 No customer data stored. Responding to data request for shop: ${shop}`);
                break;

            case "CUSTOMERS_REDACT":
                //Logic for removing customer data goes here...
                console.log(`📌 No customer data stored. Ignoring redaction request for shop: ${shop}`);
                break;

            case "SHOP_REDACT":
                //Logic for removing shop data goes here...
                console.log(`📌 No shop data stored. Acknowledging shop deletion request for shop: ${shop}`);
                break;

            default:
                console.warn(`❌ Unhandled webhook topic: ${topic}`);
                return new Response("Unhandled webhook topic", { status: 400 });
        }

        // Return 200 only if authentication and processing succeeded
        return new Response("Webhook received", { status: 200 });

    } catch (authError) {
        // Specifically handle HMAC validation failures
        console.error("🔒 Webhook authentication failed:", authError);
        return new Response("Webhook HMAC validation failed", { status: 401 });
    }

};
