<template>
    <div class="authPage">
        <div class="authCard">
            <header class="authHeader">
                <h1>{{ headerTitle }}</h1>
                <p>{{ headerSubtitle }}</p>
            </header>

            <div class="authTabs" role="tablist" aria-label="登入與註冊">
                <button
                    type="button"
                    class="authTab"
                    :class="{ active: mode === 'login' }"
                    role="tab"
                    :aria-selected="mode === 'login'"
                    @click="switchMode('login')"
                >
                    登入
                </button>
                <button
                    type="button"
                    class="authTab"
                    :class="{ active: mode === 'register' }"
                    role="tab"
                    :aria-selected="mode === 'register'"
                    @click="switchMode('register')"
                >
                    註冊
                </button>
            </div>

            <form v-if="mode === 'login'" class="authForm" @submit.prevent="handleLogin">
                <label class="authField">
                    電子郵件
                    <input v-model.trim="loginEmail" type="email" autocomplete="email" required />
                </label>
                <label class="authField">
                    密碼
                    <input v-model="loginPassword" type="password" autocomplete="current-password" required />
                </label>
                <button type="submit" class="authButton primary">登入</button>
            </form>

            <form v-else class="authForm" @submit.prevent="handleRegister">
                <label class="authField">
                    電子郵件
                    <input v-model.trim="registerEmail" type="email" autocomplete="email" required />
                </label>
                <label class="authField">
                    密碼
                    <input v-model="registerPassword" type="password" autocomplete="new-password" required />
                </label>
                <label class="authField">
                    確認密碼
                    <input v-model="registerPasswordConfirm" type="password" autocomplete="new-password" required />
                </label>
                <button type="submit" class="authButton">建立帳號</button>
            </form>

            <p v-if="statusMessage" class="authStatus" role="status">{{ statusMessage }}</p>
        </div>
    </div>
</template>

<script setup>
import { computed, ref } from "vue";

const mode = ref("register");
const loginEmail = ref("");
const loginPassword = ref("");
const registerEmail = ref("");
const registerPassword = ref("");
const registerPasswordConfirm = ref("");
const statusMessage = ref("");

const headerTitle = computed(() => (mode.value === "register" ? "建立帳號" : "歡迎回來"));
const headerSubtitle = computed(() =>
    mode.value === "register" ? "建立新帳號後即可登入系統。" : "使用註冊的電子郵件登入。"
);

function switchMode(nextMode) {
    mode.value = nextMode;
    statusMessage.value = "";
}

function handleRegister() {
    if (registerPassword.value !== registerPasswordConfirm.value) {
        statusMessage.value = "兩次輸入的密碼不一致，請重新確認。";
        return;
    }

    loginEmail.value = registerEmail.value;
    loginPassword.value = "";
    statusMessage.value = "註冊成功！請使用剛剛的電子郵件登入。";
    mode.value = "login";
    registerPassword.value = "";
    registerPasswordConfirm.value = "";
}

function handleLogin() {
    statusMessage.value = `準備登入：${loginEmail.value || "(未填寫電子郵件)"}`;
}
</script>

<style scoped>
.authPage {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #0f172a, #1e293b);
    padding: 24px;
}

.authCard {
    width: min(420px, 100%);
    background: #ffffff;
    border-radius: 16px;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.25);
    padding: 28px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.authHeader h1 {
    margin: 0;
    font-size: 24px;
    color: #0f172a;
}

.authHeader p {
    margin: 6px 0 0;
    color: #475569;
    font-size: 14px;
}

.authTabs {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    background: #f1f5f9;
    padding: 6px;
    border-radius: 999px;
}

.authTab {
    border: none;
    background: transparent;
    padding: 8px 12px;
    border-radius: 999px;
    font-weight: 600;
    color: #475569;
    cursor: pointer;
    transition: all 0.2s ease;
}

.authTab.active {
    background: #2563eb;
    color: #ffffff;
    box-shadow: 0 6px 12px rgba(37, 99, 235, 0.35);
}

.authForm {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.authField {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 14px;
    color: #1e293b;
}

.authField input {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #cbd5f5;
    font-size: 14px;
}

.authButton {
    border: none;
    border-radius: 10px;
    padding: 10px 12px;
    background: #0f172a;
    color: #ffffff;
    font-weight: 600;
    cursor: pointer;
}

.authButton.primary {
    background: #2563eb;
}

.authStatus {
    margin: 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: #eff6ff;
    color: #1d4ed8;
    font-size: 13px;
}
</style>
