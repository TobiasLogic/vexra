export const PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefix: 'sk-or-',
    keyHint: 'sk-or-v1-...',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'openai/gpt-4o',
    supportsModelsEndpoint: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyPrefix: 'sk-',
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-4o',
    supportsModelsEndpoint: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyPrefix: 'sk-ant-',
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-4-20250514',
    supportsModelsEndpoint: false,
  },
  {
    id: 'google',
    name: 'Google AI (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyPrefix: 'AI',
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-flash',
    supportsModelsEndpoint: false,
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPrefix: 'gsk_',
    keyHint: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    supportsModelsEndpoint: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyPrefix: 'sk-',
    keyHint: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-chat',
    supportsModelsEndpoint: true,
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    keyPrefix: 'xai-',
    keyHint: 'xai-...',
    keyUrl: 'https://console.x.ai/',
    defaultModel: 'grok-3-latest',
    supportsModelsEndpoint: true,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    keyPrefix: '',
    keyHint: 'your-api-key',
    keyUrl: '',
    defaultModel: '',
    supportsModelsEndpoint: true,
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyPrefix: '',
    keyHint: 'Leave empty for local Ollama',
    keyUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
    supportsModelsEndpoint: true,
  },
];

export function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

export function getProviderChoices() {
  return PROVIDERS.map(p => ({
    value: p.id,
    label: p.name,
    hint: p.id === 'custom' ? 'any OpenAI-compatible API' : p.baseUrl,
  }));
}
