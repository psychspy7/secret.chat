// Only the product is identified; account details and conversation data stay in the app.
export const REVIEW_URL = 'https://kittycorp.vercel.app/contact?subject=Review&product=SecretChat';
export function openReview(openBrowser) { return openBrowser({ url: REVIEW_URL }); }
