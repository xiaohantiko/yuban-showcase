export const gptSchemaRoute = '/api/gpt/openapi.json';
export const gptChainAboutRoute = '/api/gpt/chain-about';

export function configuredGptToolToken() { return null; }
export function createGptOpenAPI() { return null; }
export function hasGptToolBearer() { return false; }
export function handleGptChainAbout() {
  throw new Error('This integration is unavailable.');
}
