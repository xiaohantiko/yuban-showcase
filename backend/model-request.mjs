export function chatCompletionBody(endpoint, model, messages) {
  const body = { model, messages, stream: false };
  if (new URL(endpoint).origin === 'https://api.deepseek.com') {
    body.thinking = { type: 'disabled' };
  }
  return JSON.stringify(body);
}
