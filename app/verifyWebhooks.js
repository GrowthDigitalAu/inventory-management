import crypto from "crypto";

/**
 * Verifies the HMAC signature of a Shopify webhook request.
 * Follows strict Shopify documentation guidelines.
 * 
 * @param {Request} request - The incoming webhook request
 * @returns {Promise<boolean>} - True if valid, false otherwise
 */
export async function verifyWebhook(request) {
    const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");
    const secret = process.env.SHOPIFY_API_SECRET;

    if (!hmacHeader) {
        console.error("❌ Missing X-Shopify-Hmac-Sha256 header");
        return false;
    }

    if (!secret) {
        console.error("❌ Missing SHOPIFY_API_SECRET environment variable");
        return false;
    }

    try {
        // Clone the request to ensure we don't consume the stream for other listeners
        const requestClone = request.clone();

        // Get the raw body as text. This is critical: Shopify hashes the RAW body.
        // Do NOT parse as JSON and re-stringify, as that changes whitespace/ordering.
        const body = await requestClone.text();

        // Calculate the HMAC using SHA256 and the API Secret
        const generatedHash = crypto
            .createHmac("sha256", secret)
            .update(body, "utf8")
            .digest("base64");

        // Perform a timing-safe comparison to prevent timing attacks
        const signatureBuffer = Buffer.from(hmacHeader, "utf8");
        const generatedBuffer = Buffer.from(generatedHash, "utf8");

        if (signatureBuffer.length !== generatedBuffer.length) {
            console.warn("⚠️ HMAC length mismatch (Invalid Signature)");
            return false;
        }

        const isValid = crypto.timingSafeEqual(signatureBuffer, generatedBuffer);

        if (!isValid) {
            console.warn("⚠️ HMAC signature mismatch");
        }

        return isValid;
    } catch (error) {
        console.error("❌ Error verifying webhook HMAC:", error);
        return false;
    }
}
