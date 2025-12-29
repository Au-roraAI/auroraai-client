/**
 * key.js
 * Handles secure retrieval of API keys.
 * Priority: 1. User provided key (localStorage) -> 2. Local Dev Key (/secrets/devkey.json)
 */

const STORAGE_KEY = 'aurora_user_key';
const DEV_KEY_PATH = '/secrets/devkey.json';

export const KeyManager = {
    setUserKey: (key) => {
        if (!key) return;
        localStorage.setItem(STORAGE_KEY, key);
    },

    clearUserKey: () => {
        localStorage.removeItem(STORAGE_KEY);
    },

    getUserKey: () => {
        return localStorage.getItem(STORAGE_KEY);
    },

    fetchDevKey: async () => {
        try {
            const response = await fetch(DEV_KEY_PATH);
            if (response.ok) {
                const data = await response.json();
                return data.OPENROUTER_KEY || null;
            }
        } catch (e) {
            console.log('No local dev key found.');
        }
        return null;
    },

    getEffectiveKey: async () => {
        const userKey = localStorage.getItem(STORAGE_KEY);
        if (userKey) return userKey;

        const devKey = await KeyManager.fetchDevKey();
        if (devKey) return devKey;

        return null;
    }
};