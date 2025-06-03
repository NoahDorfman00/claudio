// Initialize Firebase
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyDrKGKt6rdqPZnyD0cXYrDjbbVNhENqzhk",
    authDomain: "claudio-13341.firebaseapp.com",
    projectId: "claudio-13341",
    storageBucket: "claudio-13341.firebasestorage.app",
    messagingSenderId: "573081656715",
    appId: "1:573081656715:web:99dc011cd5697594bc238e",
    measurementId: "G-4FYRTE51F2"
};

initializeApp(firebaseConfig);
const functions = getFunctions();

// Connect to local emulator if running on localhost
if (location.hostname === "localhost") {
    connectFunctionsEmulator(functions, "localhost", 5001);
}

const claudioAI = httpsCallable(functions, 'claudioAI');

const chatWindow = document.getElementById('chat-window');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');

// Maintain the conversation array
let conversation = [];
let retryButton = null;
let lastTriedConversation = null;

function appendMessage(sender, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    messageDiv.appendChild(bubble);
    chatWindow.appendChild(messageDiv);
}

function appendRetryButton() {
    // Remove any existing retry button
    if (retryButton && retryButton.parentNode) {
        retryButton.parentNode.removeChild(retryButton);
    }
    retryButton = document.createElement('button');
    retryButton.textContent = 'Retry';
    retryButton.className = 'retry-btn';
    retryButton.type = 'button';
    // Match the submit button's style
    retryButton.classList.add('submit-btn'); // We'll add this class in CSS to match button[type="submit"]
    retryButton.onclick = async function () {
        if (retryButton && retryButton.parentNode) {
            retryButton.parentNode.removeChild(retryButton);
        }
        appendMessage('bot', 'Claudio is thinking...');
        try {
            const result = await claudioAI({ messages: lastTriedConversation });
            console.log(result);
            chatWindow.removeChild(chatWindow.lastChild);
            const fullReply = result.data.fullReply || '';
            let displayReply = 'Sorry, I could not get a response.';
            let match = fullReply.match(/<response>([\s\S]*?)<\/response>/i);
            if (match && match[1].trim()) {
                displayReply = match[1].trim();
            } else {
                match = fullReply.match(/<response>([\s\S]*)/i);
                if (match && match[1].trim()) {
                    displayReply = match[1].trim();
                }
            }
            conversation.push({ role: 'assistant', content: fullReply });
            appendMessage('bot', displayReply);
            if (!(match && match[1].trim())) {
                appendRetryButton();
            }
        } catch (err) {
            chatWindow.removeChild(chatWindow.lastChild);
            appendRetryButton();
        }
    };
    // Insert retry button after chat window, before form
    chatWindow.parentNode.insertBefore(retryButton, chatForm);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = userInput.value.trim();
    if (!text) return;
    appendMessage('user', text);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    userInput.value = '';
    // Add user message to conversation
    conversation.push({ role: 'user', content: text });
    appendMessage('bot', 'Claudio is thinking...');
    lastTriedConversation = conversation.slice(); // Save a copy for retry

    try {
        // Send the full conversation to the backend
        const result = await claudioAI({ messages: conversation });
        console.log(result);
        chatWindow.removeChild(chatWindow.lastChild);
        // Extract the <response>...</response> part for display
        const fullReply = result.data.fullReply || '';
        let displayReply = 'Sorry, I could not get a response.';
        let match = fullReply.match(/<response>([\s\S]*?)<\/response>/i);
        if (match && match[1].trim()) {
            displayReply = match[1].trim();
        } else {
            // Try to match just <response> and take everything after it
            match = fullReply.match(/<response>([\s\S]*)/i);
            if (match && match[1].trim()) {
                displayReply = match[1].trim();
            }
        }
        // Add the full reply as assistant message to conversation
        conversation.push({ role: 'assistant', content: fullReply });
        appendMessage('bot', displayReply);
        // Remove retry button if present
        if (retryButton && retryButton.parentNode) {
            retryButton.parentNode.removeChild(retryButton);
        }
        if (!(match && match[1].trim())) {
            appendRetryButton();
        }
    } catch (err) {
        chatWindow.removeChild(chatWindow.lastChild);
        appendMessage('bot', 'Oops! Something went wrong.');
        appendRetryButton();
    }
}); 