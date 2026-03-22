(() => {
  "use strict";

  // =========================
  // 配置项
  // =========================
  const STORAGE_KEYS = {
    KEEP_TURNS: "keepTurns",
    AUTO_TRIM: "autoTrimEnabled"
  };

  // 默认保留最近多少个对话块
  const DEFAULT_KEEP_TURNS = 5;

  // 默认开启“自动移除旧对话”
  const DEFAULT_AUTO_TRIM = true;

  // MutationObserver 触发后，延迟多少毫秒再真正执行裁剪
  // 用于防抖，避免 DOM 连续变化时频繁处理
  const DEBOUNCE_MS = 400;

  // =========================
  // 运行时状态
  // =========================
  const state = {
    started: false,

    // 当前保留数量
    keepTurns: DEFAULT_KEEP_TURNS,

    // 自动移除旧对话开关
    autoTrimEnabled: DEFAULT_AUTO_TRIM,

    // 被裁掉但缓存起来的旧节点
    cachedNodes: [],

    // 自动裁剪的防抖定时器
    cleanupTimer: null,

    // 会话切换后的重新初始化定时器
    reinitTimer: null,

    // DOM 监听器
    observer: null,

    // 标记当前 DOM 变更是否由插件自己触发
    // 防止 remove / insert 引发递归 observer
    internalMutating: false,

    // 当前会话 key
    lastConversationKey: "",

    // 是否已安装前端路由监听
    routeWatcherInstalled: false,

    // 恢复一段后，暂缓自动裁剪
    // 直到新的真实消息出现，才恢复自动裁剪
    autoTrimSuspendedAfterRestore: false,

    // 记录最近一次已知的对话块数量
    lastKnownLiveCount: 0
  };

  // =========================
  // 工具函数
  // =========================

  function withInternalMutation(fn) {
    state.internalMutating = true;
    try {
      fn();
    } finally {
      state.internalMutating = false;
    }
  }

  // 用 path + query 作为当前会话标识
  function getConversationKey() {
    return `${location.pathname}${location.search}`;
  }

  // ChatGPT 会话主区域
  function getThreadRoot() {
    return document.querySelector("#thread") || document.querySelector("main");
  }

  // 查找当前页面里的对话块
  // 优先匹配新版 section[data-turn-id]
  // 找不到再回退到 article
  function findTurnElements() {
    const root = getThreadRoot();
    if (!root) return [];

    const turnSections = Array.from(
      root.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn-id]')
    );
    if (turnSections.length > 0) return turnSections;

    const genericTurnSections = Array.from(
      root.querySelectorAll("section[data-turn-id]")
    );
    if (genericTurnSections.length > 0) return genericTurnSections;

    return Array.from(root.querySelectorAll("article"));
  }

  // 判断一个 DOM 节点是不是和会话区相关
  function isRelevantConversationNode(node) {
    const el =
      node instanceof Element
        ? node
        : node instanceof Text
          ? node.parentElement
          : null;

    if (!el) return false;

    if (
      el.matches?.(
        '#thread, article, section[data-turn-id], section[data-testid^="conversation-turn-"][data-turn-id]'
      )
    ) {
      return true;
    }

    if (
      el.querySelector?.(
        '#thread, article, section[data-turn-id], section[data-testid^="conversation-turn-"][data-turn-id]'
      )
    ) {
      return true;
    }

    return !!el.closest("main, #thread");
  }

  // 查找当前滚动容器
  function getScrollContainer(startEl) {
    let el = startEl?.parentElement || null;

    while (el && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;

      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight
      ) {
        return el;
      }

      el = el.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  // 捕获当前视口里的锚点节点
  // 恢复历史后用它修正滚动位置，减少页面跳动
  function captureVisibleAnchor() {
    const nodes = findTurnElements();
    let anchorEl = null;
    let anchorTop = 0;

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        anchorEl = node;
        anchorTop = rect.top;
        break;
      }
    }

    if (!anchorEl && nodes.length > 0) {
      anchorEl = nodes[0];
      anchorTop = anchorEl.getBoundingClientRect().top;
    }

    return { anchorEl, anchorTop };
  }

  // 恢复历史后修正滚动位置
  function restoreScrollPosition(anchorEl, oldTop) {
    if (!anchorEl) return;

    requestAnimationFrame(() => {
      const newTop = anchorEl.getBoundingClientRect().top;
      const delta = newTop - oldTop;
      const scroller = getScrollContainer(anchorEl);

      if (
        scroller === document.scrollingElement ||
        scroller === document.documentElement ||
        scroller === document.body
      ) {
        window.scrollBy(0, delta);
      } else {
        scroller.scrollTop += delta;
      }
    });
  }

  function clearConversationCache() {
    state.cachedNodes = [];
  }

  function clearPendingCleanup() {
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }
  }

  function clearPendingReinit() {
    if (state.reinitTimer) {
      clearTimeout(state.reinitTimer);
      state.reinitTimer = null;
    }
  }

  // =========================
  // 会话初始化 / 切换处理
  // =========================

  // 等待新会话 DOM 真正挂载完成
  // ChatGPT 是 SPA，切换会话后内容不会立刻准备好
  function waitForConversationReady(retry = 0) {
    const root = getThreadRoot();
    const nodes = findTurnElements();

    if (!root || nodes.length === 0) {
      if (retry < 30) {
        setTimeout(() => waitForConversationReady(retry + 1), 250);
      }
      return;
    }

    // 新会话开始时，刷新当前已知数量
    state.lastKnownLiveCount = nodes.length;

    // 新会话准备好后，按当前设置重新进入自动裁剪流程
    if (state.autoTrimEnabled) {
      scheduleAutoCleanup();
    }
  }

  // 真正的“切换会话后重新初始化”
  function reinitializeForCurrentConversation() {
    clearPendingCleanup();
    clearPendingReinit();

    // 清掉旧会话缓存，避免跨会话污染
    clearConversationCache();

    // 新会话开始后，不保留旧会话里的“恢复后暂缓”状态
    state.autoTrimSuspendedAfterRestore = false;

    // 更新当前会话 key
    state.lastConversationKey = getConversationKey();

    // 等新会话 DOM 出来后重新裁剪
    waitForConversationReady(0);
  }

  function scheduleConversationReinit() {
    clearPendingReinit();

    state.reinitTimer = setTimeout(() => {
      state.reinitTimer = null;
      reinitializeForCurrentConversation();
    }, 200);
  }

  // 如果发现当前 URL 已经对应新会话，就调度重新初始化
  function ensureConversationState() {
    const key = getConversationKey();

    if (state.lastConversationKey !== key) {
      scheduleConversationReinit();
    }
  }

  // 监听 ChatGPT 的前端路由切换
  // 因为它是单页应用，不会重新加载 content script
  function installRouteWatcher() {
    if (state.routeWatcherInstalled) return;
    state.routeWatcherInstalled = true;

    let lastHref = location.href;

    function checkRouteChange() {
      if (location.href === lastHref) return;

      lastHref = location.href;
      scheduleConversationReinit();
    }

    const rawPushState = history.pushState;
    history.pushState = function (...args) {
      const result = rawPushState.apply(this, args);
      queueMicrotask(checkRouteChange);
      return result;
    };

    const rawReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = rawReplaceState.apply(this, args);
      queueMicrotask(checkRouteChange);
      return result;
    };

    window.addEventListener("popstate", checkRouteChange);
    window.addEventListener("hashchange", checkRouteChange);
  }

  // =========================
  // popup 状态读取
  // =========================

  function getState() {
    ensureConversationState();

    const liveCount = findTurnElements().length;
    const cachedCount = state.cachedNodes.length;

    // 同步当前已知数量
    state.lastKnownLiveCount = liveCount;

    return {
      success: true,
      keepTurns: state.keepTurns,
      autoTrimEnabled: state.autoTrimEnabled,
      autoTrimSuspendedAfterRestore: state.autoTrimSuspendedAfterRestore,
      liveCount,
      cachedCount,
      canCollapse: liveCount > state.keepTurns,
      canRestore: cachedCount > 0,
      conversationKey: state.lastConversationKey
    };
  }

  // =========================
  // 核心逻辑：裁剪
  // =========================

  function collapseOldTurns(force = false) {
    ensureConversationState();

    // 自动模式关闭时，不响应自动触发
    // 但手动“立即裁剪”仍然允许
    if (!state.autoTrimEnabled && !force) {
      return {
        ...getState(),
        message: "自动移除旧对话已关闭。"
      };
    }

    const nodes = findTurnElements();
    if (nodes.length === 0) {
      return {
        ...getState(),
        success: false,
        message: "未找到对话块。"
      };
    }

    const excess = nodes.length - state.keepTurns;
    if (excess <= 0) {
      state.lastKnownLiveCount = nodes.length;
      return {
        ...getState(),
        message: "当前无需裁剪。"
      };
    }

    // 取最早的一批节点移除
    const toCollapse = nodes.slice(0, excess);

    withInternalMutation(() => {
      for (const node of toCollapse) {
        state.cachedNodes.push({
          node,
          parent: node.parentNode
        });

        // 真正从 DOM 删除，减轻页面负担
        node.remove();
      }
    });

    state.lastKnownLiveCount = findTurnElements().length;

    return {
      ...getState(),
      message: `已裁剪 ${toCollapse.length} 个对话块。`
    };
  }

  // =========================
  // 核心逻辑：分批恢复
  // =========================

  function restoreNextChunk() {
    ensureConversationState();

    if (state.cachedNodes.length === 0) {
      return {
        ...getState(),
        message: "没有可恢复的历史。"
      };
    }

    const root = getThreadRoot();
    if (!root) {
      return {
        ...getState(),
        success: false,
        message: "未找到会话根节点。"
      };
    }

    // 恢复前记录锚点位置，避免页面跳动
    const { anchorEl, anchorTop } = captureVisibleAnchor();

    const liveNodes = findTurnElements();
    const beforeNode = liveNodes[0] || null;

    // 优先插到当前最前面对话块之前
    const parent =
      beforeNode?.parentNode ||
      state.cachedNodes[state.cachedNodes.length - 1]?.parent ||
      root;

    // 每次只恢复 keepTurns 个
    // 从缓存尾部拿，这样是分段向前恢复
    const start = Math.max(0, state.cachedNodes.length - state.keepTurns);
    const chunk = state.cachedNodes.splice(start, state.cachedNodes.length - start);

    withInternalMutation(() => {
      for (const item of chunk) {
        const node = item.node;
        if (!node) continue;

        if (beforeNode && parent === beforeNode.parentNode) {
          parent.insertBefore(node, beforeNode);
        } else if (item.parent && item.parent.isConnected) {
          item.parent.appendChild(node);
        } else {
          parent.appendChild(node);
        }
      }
    });

    restoreScrollPosition(anchorEl, anchorTop);

    // 恢复后先暂缓自动裁剪，避免刚恢复又被立刻裁掉
    state.autoTrimSuspendedAfterRestore = true;
    state.lastKnownLiveCount = findTurnElements().length;

    return {
      ...getState(),
      message: `已恢复 ${chunk.length} 个对话块。`
    };
  }

  // =========================
  // 自动裁剪调度
  // =========================

  function scheduleAutoCleanup() {
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
    }

    state.cleanupTimer = setTimeout(() => {
      state.cleanupTimer = null;

      if (state.autoTrimEnabled && !state.autoTrimSuspendedAfterRestore) {
        collapseOldTurns(false);
      }
    }, DEBOUNCE_MS);
  }

  // 监听页面 DOM 变化
  // 新消息到来时自动判断是否需要裁剪
  function startObserver() {
    if (state.observer) return;

    state.observer = new MutationObserver((mutations) => {
      if (state.internalMutating) return;

      ensureConversationState();

      let hasRelevantChange = false;
      let hasAddedConversationNode = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (isRelevantConversationNode(node)) {
            hasRelevantChange = true;
            hasAddedConversationNode = true;
            break;
          }
        }
        if (hasAddedConversationNode) break;

        for (const node of mutation.removedNodes) {
          if (isRelevantConversationNode(node)) {
            hasRelevantChange = true;
            break;
          }
        }
        if (hasRelevantChange) break;
      }

      if (!hasRelevantChange) return;

      const liveCount = findTurnElements().length;
      const liveCountIncreased = liveCount > state.lastKnownLiveCount;

      // 如果当前处于“恢复后暂缓自动裁剪”状态：
      // 只有当新的真实对话块增加时，才解除暂缓并恢复自动裁剪
      if (state.autoTrimSuspendedAfterRestore) {
        if (hasAddedConversationNode && liveCountIncreased) {
          state.autoTrimSuspendedAfterRestore = false;
          state.lastKnownLiveCount = liveCount;

          if (state.autoTrimEnabled) {
            scheduleAutoCleanup();
          }
        } else {
          state.lastKnownLiveCount = liveCount;
        }
        return;
      }

      state.lastKnownLiveCount = liveCount;

      if (state.autoTrimEnabled) {
        scheduleAutoCleanup();
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // =========================
  // 配置读写
  // =========================

  async function initConfig() {
    try {
      const result = await chrome.storage.local.get({
        [STORAGE_KEYS.KEEP_TURNS]: DEFAULT_KEEP_TURNS,
        [STORAGE_KEYS.AUTO_TRIM]: DEFAULT_AUTO_TRIM
      });

      state.keepTurns =
        Math.max(1, Number(result[STORAGE_KEYS.KEEP_TURNS]) || DEFAULT_KEEP_TURNS);

      state.autoTrimEnabled = Boolean(result[STORAGE_KEYS.AUTO_TRIM]);
    } catch {
      state.keepTurns = DEFAULT_KEEP_TURNS;
      state.autoTrimEnabled = DEFAULT_AUTO_TRIM;
    }
  }

  async function setKeepTurns(value) {
    const next = Math.max(1, Number(value) || DEFAULT_KEEP_TURNS);
    state.keepTurns = next;

    await chrome.storage.local.set({
      [STORAGE_KEYS.KEEP_TURNS]: next
    });

    // 保存后立即按新配置生效：
    // 如果当前页面对话块超出了新的 keepTurns，就立刻裁剪。
    // 这里用 force=true，因为这是用户主动保存，不受自动裁剪开关影响。
    const liveCount = findTurnElements().length;

    if (liveCount > state.keepTurns) {
      const result = collapseOldTurns(true);
      return {
        ...result,
        message: `保留数量已设置为 ${next}。`
      };
    }

    state.lastKnownLiveCount = liveCount;

    return {
      ...getState(),
      message: `保留数量已设置为 ${next}。`
    };
  }

  async function setAutoTrimEnabled(value) {
    state.autoTrimEnabled = !!value;

    await chrome.storage.local.set({
      [STORAGE_KEYS.AUTO_TRIM]: state.autoTrimEnabled
    });

    if (state.autoTrimEnabled && !state.autoTrimSuspendedAfterRestore) {
      scheduleAutoCleanup();
    }

    return {
      ...getState(),
      message: state.autoTrimEnabled
        ? "自动移除旧对话已开启。"
        : "自动移除旧对话已关闭。"
    };
  }

  // =========================
  // popup 消息通信
  // =========================

  function onMessage(request, _sender, sendResponse) {
    try {
      if (request.action === "ping") {
        sendResponse({ success: true, message: "content script loaded" });
        return true;
      }

      if (request.action === "getState") {
        sendResponse(getState());
        return true;
      }

      if (request.action === "collapseNow") {
        sendResponse(collapseOldTurns(true));
        return true;
      }

      if (request.action === "restoreNextChunk") {
        sendResponse(restoreNextChunk());
        return true;
      }

      if (request.action === "setKeepTurns") {
        setKeepTurns(request.keepTurns)
          .then((result) => sendResponse(result))
          .catch((error) =>
            sendResponse({
              success: false,
              message: error.message || "设置失败。"
            })
          );
        return true;
      }

      if (request.action === "setAutoTrimEnabled") {
        setAutoTrimEnabled(request.enabled)
          .then((result) => sendResponse(result))
          .catch((error) =>
            sendResponse({
              success: false,
              message: error.message || "设置失败。"
            })
          );
        return true;
      }

      sendResponse({ success: false, message: "未知操作。" });
      return true;
    } catch (error) {
      sendResponse({
        success: false,
        message: error?.message || "处理消息时出错。"
      });
      return true;
    }
  }

  // =========================
  // 启动
  // =========================

  async function waitForReady() {
    if (state.started) return;

    const root = getThreadRoot();
    if (!root) {
      setTimeout(waitForReady, 500);
      return;
    }

    state.started = true;
    state.lastConversationKey = getConversationKey();
    state.lastKnownLiveCount = findTurnElements().length;

    await initConfig();

    // DOM 观察器
    startObserver();

    // ChatGPT SPA 路由切换监听
    installRouteWatcher();

    // 首次进入页面时先执行一次自动裁剪检查
    scheduleAutoCleanup();

    chrome.runtime.onMessage.addListener(onMessage);
    console.log("[CGPT-PRUNER] started");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForReady, { once: true });
  } else {
    waitForReady();
  }
})();
