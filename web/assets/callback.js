import { RETURN_URL_KEY, createCallbackClient, safeReturnUrl } from "./auth.js";

const status = document.getElementById("callback-status");
const config = window.DAILY_CS_CONFIG ?? {};

async function finish() {
  try {
    const client = createCallbackClient(config, window.sessionStorage);
    const { error } = await client.auth.getSession();
    if (error) throw error;
    const target = safeReturnUrl(sessionStorage.getItem(RETURN_URL_KEY), location, config.basePath ?? "/Daily_CS/");
    sessionStorage.removeItem(RETURN_URL_KEY);
    location.replace(target);
  } catch (error) {
    status.dataset.tone = "error";
    status.textContent = error instanceof Error ? error.message : "로그인 처리를 완료하지 못했습니다.";
  }
}

finish();
