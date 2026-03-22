const keepTurnsInput = document.getElementById("keepTurns");
const saveKeepTurnsBtn = document.getElementById("saveKeepTurns");
const autoTrimCheckbox = document.getElementById("autoTrimEnabled");
const collapseNowBtn = document.getElementById("collapseNow");
const restoreNextBtn = document.getElementById("restoreNext");
const statusEl = document.getElementById("status");

// popup 打开时启动一个定时刷新
// 这样即使 popup 保持展开，状态也会自动更新
let refreshTimer = null;

// 标记用户是否正在编辑保留数量输入框
let isEditingKeepTurns = false;

// 记录最近一次 content script 确认的已保存值
let lastCommittedKeepTurns = null;

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

// 根据当前输入值和已保存值，更新“保存”按钮是否可用
function updateSaveButtonState() {
  const currentValue = Math.max(1, Number(keepTurnsInput.value) || 1);
  const committedValue =
    lastCommittedKeepTurns === null
      ? null
      : Math.max(1, Number(lastCommittedKeepTurns) || 1);

  // 没拿到服务端状态前，先禁用
  if (committedValue === null) {
    saveKeepTurnsBtn.disabled = true;
    return;
  }

  saveKeepTurnsBtn.disabled = currentValue === committedValue;
}

// 根据 content script 返回的状态更新 popup UI
// syncInput=false 时，不去覆盖用户当前输入框里的内容
function renderState(data, { syncInput = false } = {}) {
  if (!data?.success) {
    statusEl.textContent = data?.message || "读取失败。";
    collapseNowBtn.disabled = true;
    restoreNextBtn.disabled = true;
    autoTrimCheckbox.disabled = true;
    saveKeepTurnsBtn.disabled = true;
    return;
  }

  lastCommittedKeepTurns = data.keepTurns ?? lastCommittedKeepTurns;

  // 只有首次加载、保存成功后，或者明确要求同步输入框时，才刷新输入框
  if (syncInput && !isEditingKeepTurns) {
    keepTurnsInput.value = data.keepTurns ?? "";
  }

  autoTrimCheckbox.checked = !!data.autoTrimEnabled;

  statusEl.textContent =
    `当前页面对话块：${data.liveCount}\n` +
    `已缓存历史块：${data.cachedCount}\n` +
    `自动移除旧对话：${data.autoTrimEnabled ? "开启" : "关闭"}\n` +
    `恢复后暂缓：${data.autoTrimSuspendedAfterRestore ? "是" : "否"}`;

  collapseNowBtn.disabled = !data.canCollapse;
  restoreNextBtn.disabled = !data.canRestore;
  autoTrimCheckbox.disabled = false;

  // 最后再统一更新保存按钮状态
  updateSaveButtonState();
}

// 主动拉一次状态
// forceSyncInput=true 时，允许刷新输入框
async function refreshState({ forceSyncInput = false } = {}) {
  try {
    const result = await sendToActiveTab({ action: "getState" });
    renderState(result, { syncInput: forceSyncInput });
  } catch (_error) {
    renderState({
      success: false,
      message: "当前标签页不是 ChatGPT 页面，或 content script 尚未加载。"
    });
  }
}

// ===== 输入框编辑状态管理 =====

// 聚焦时，进入“正在编辑”状态
keepTurnsInput.addEventListener("focus", () => {
  isEditingKeepTurns = true;
});

// 输入时，保持“正在编辑”状态，并实时刷新保存按钮
keepTurnsInput.addEventListener("input", () => {
  isEditingKeepTurns = true;
  updateSaveButtonState();
});

// 失焦时，如果输入值已经等于最近一次保存值，就退出编辑状态
keepTurnsInput.addEventListener("blur", () => {
  const currentValue = Math.max(1, Number(keepTurnsInput.value) || 1);
  const committedValue =
    lastCommittedKeepTurns === null
      ? null
      : Math.max(1, Number(lastCommittedKeepTurns) || 1);

  if (committedValue !== null && currentValue === committedValue) {
    isEditingKeepTurns = false;
  }

  updateSaveButtonState();
});

// 保存 keepTurns
saveKeepTurnsBtn.addEventListener("click", async () => {
  const value = Math.max(1, Number(keepTurnsInput.value) || 1);

  const result = await sendToActiveTab({
    action: "setKeepTurns",
    keepTurns: value
  });

  // 保存成功后，认为当前输入已提交
  isEditingKeepTurns = false;

  // 这次要强制同步输入框和状态区，保证“立刻刷新”
  renderState(result, { syncInput: true });

  // 再补一次主动刷新，确保按钮状态 / 统计数字也和页面完全一致
  await refreshState({ forceSyncInput: true });
});

// 切换自动裁剪开关
autoTrimCheckbox.addEventListener("change", async () => {
  const result = await sendToActiveTab({
    action: "setAutoTrimEnabled",
    enabled: autoTrimCheckbox.checked
  });
  renderState(result, { syncInput: false });
});

// 手动立即裁剪
collapseNowBtn.addEventListener("click", async () => {
  const result = await sendToActiveTab({ action: "collapseNow" });
  renderState(result, { syncInput: false });
});

// 手动恢复一段
restoreNextBtn.addEventListener("click", async () => {
  const result = await sendToActiveTab({ action: "restoreNextChunk" });
  renderState(result, { syncInput: false });
});

// popup 每次打开都会触发 DOMContentLoaded
// 首次加载时同步一次输入框，然后开启轮询
document.addEventListener("DOMContentLoaded", async () => {
  await refreshState({ forceSyncInput: true });

  refreshTimer = setInterval(() => {
    // 自动刷新时不覆盖输入框
    refreshState({ forceSyncInput: false });
  }, 1000);
});

// popup 关闭时清理定时器
window.addEventListener("unload", () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
