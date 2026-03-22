const keepTurnsInput = document.getElementById("keepTurns");
const saveKeepTurnsBtn = document.getElementById("saveKeepTurns");
const autoTrimCheckbox = document.getElementById("autoTrimEnabled");
const collapseNowBtn = document.getElementById("collapseNow");
const restoreNextBtn = document.getElementById("restoreNext");
const statusEl = document.getElementById("status");

// popup 打开时启动一个定时刷新
let refreshTimer = null;

// 获取当前激活标签页
async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0];
}

// 给当前标签页的 content script 发消息
async function sendToActiveTab(message) {
  const tab = await getActiveTab();

  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }

  return chrome.tabs.sendMessage(tab.id, message);
}

// 根据 content script 返回的状态更新 popup UI
function renderState(data) {
  if (!data?.success) {
    statusEl.textContent = data?.message || "读取失败。";
    collapseNowBtn.disabled = true;
    restoreNextBtn.disabled = true;
    autoTrimCheckbox.disabled = true;
    saveKeepTurnsBtn.disabled = true;
    return;
  }

  keepTurnsInput.value = data.keepTurns ?? "";
  autoTrimCheckbox.checked = !!data.autoTrimEnabled;

  statusEl.textContent =
    `当前页面对话块：${data.liveCount}\n` +
    `已缓存历史块：${data.cachedCount}\n` +
    `自动移除旧对话：${data.autoTrimEnabled ? "开启" : "关闭"}`;

  collapseNowBtn.disabled = !data.canCollapse;
  restoreNextBtn.disabled = !data.canRestore;
  autoTrimCheckbox.disabled = false;
  saveKeepTurnsBtn.disabled = false;
}

// 主动拉一次状态
async function refreshState() {
  try {
    const result = await sendToActiveTab({ action: "getState" });
    renderState(result);
  } catch (_error) {
    renderState({
      success: false,
      message: "当前标签页不是 ChatGPT 页面，或 content script 尚未加载。"
    });
  }
}

// 保存 keepTurns
saveKeepTurnsBtn.addEventListener("click", async () => {
  const value = Math.max(1, Number(keepTurnsInput.value) || 1);
  const result = await sendToActiveTab({
    action: "setKeepTurns",
    keepTurns: value
  });
  renderState(result);
});

// 切换自动裁剪开关
autoTrimCheckbox.addEventListener("change", async () => {
  const result = await sendToActiveTab({
    action: "setAutoTrimEnabled",
    enabled: autoTrimCheckbox.checked
  });
  renderState(result);
});

// 手动立即裁剪
collapseNowBtn.addEventListener("click", async () => {
  const result = await sendToActiveTab({ action: "collapseNow" });
  renderState(result);
});

// 手动恢复一段
restoreNextBtn.addEventListener("click", async () => {
  const result = await sendToActiveTab({ action: "restoreNextChunk" });
  renderState(result);
});

// popup 每次打开都会触发 DOMContentLoaded
// 这里先刷新一次，再开启轮询
document.addEventListener("DOMContentLoaded", async () => {
  await refreshState();

  refreshTimer = setInterval(() => {
    refreshState();
  }, 1000);
});

// popup 关闭时清理定时器
window.addEventListener("unload", () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
