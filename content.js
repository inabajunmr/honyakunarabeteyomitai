const ROLE_BY_FRAME_NAME = {
  originalPane: "original",
  translatedPane: "translated"
};

const role = ROLE_BY_FRAME_NAME[window.name];
const isTargetFrame = window.top !== window && Boolean(role);

if (isTargetFrame) {
  let lastSentAt = 0;
  let lastProgress = -1;
  let outboundSeq = 0;
  let suppressUntil = 0;
  let lastAppliedSyncId = null;
  let userIntentUntil = 0;
  let applyingRemoteUntil = 0;

  const SEND_INTERVAL_MS = 28;
  const APPLY_SUPPRESS_MS = 360;
  const MIN_PROGRESS_DELTA = 0.003;
  const ANCHOR_Y = 120;
  const MAX_PATH_DEPTH = 9;
  let lastActiveSentAt = 0;
  const ACTIVE_SIGNAL_INTERVAL_MS = 120;
  const USER_INTENT_WINDOW_MS = 1200;

  function getScroller() {
    return document.scrollingElement || document.documentElement || document.body;
  }

  function getScrollProgress() {
    const scroller = getScroller();
    if (!scroller) {
      return 0;
    }

    const max = Math.max(scroller.scrollHeight - window.innerHeight, 0);
    if (max <= 0) {
      return 0;
    }

    return Math.min(Math.max(scroller.scrollTop / max, 0), 1);
  }

  function getDocumentTopFromRect(rectTop) {
    const scroller = getScroller();
    return (scroller?.scrollTop ?? window.scrollY ?? 0) + rectTop;
  }

  function buildElementPath(element) {
    const path = [];
    let current = element;

    while (
      current &&
      current !== document.documentElement &&
      current !== document.body &&
      path.length < MAX_PATH_DEPTH
    ) {
      const parent = current.parentElement;
      if (!parent) {
        break;
      }

      const index = Array.prototype.indexOf.call(parent.children, current);
      if (index < 0) {
        break;
      }

      path.unshift(index);
      current = parent;
    }

    return path;
  }

  function resolveElementPath(path) {
    if (!Array.isArray(path)) {
      return null;
    }

    let current = document.body;
    for (const index of path) {
      if (!current || index < 0 || index >= current.children.length) {
        return null;
      }
      current = current.children[index];
    }

    return current;
  }

  function getTagOrdinal(element) {
    if (!element?.tagName) {
      return -1;
    }

    const tag = element.tagName;
    const elements = document.getElementsByTagName(tag);
    for (let i = 0; i < elements.length; i += 1) {
      if (elements[i] === element) {
        return i;
      }
    }

    return -1;
  }

  function resolveByTagOrdinal(tagName, ordinal) {
    if (!tagName || typeof ordinal !== "number" || ordinal < 0) {
      return null;
    }

    const elements = document.getElementsByTagName(tagName);
    if (ordinal >= elements.length) {
      return null;
    }

    return elements[ordinal] || null;
  }

  function pickAnchorElement() {
    const y = Math.min(ANCHOR_Y, Math.max(window.innerHeight - 1, 1));
    const x = Math.max(Math.floor(window.innerWidth / 2), 1);
    let node = document.elementFromPoint(x, y);
    if (!node) {
      return null;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      node = node.parentElement;
    }

    let element = node instanceof Element ? node : null;
    while (element && element.tagName === "SPAN" && element.parentElement) {
      element = element.parentElement;
    }

    return element;
  }

  function buildAnchor() {
    const element = pickAnchorElement();
    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const height = Math.max(rect.height, 1);
    const offsetRatio = Math.min(Math.max((Math.min(ANCHOR_Y, window.innerHeight - 1) - rect.top) / height, 0), 1);

    return {
      path: buildElementPath(element),
      tagName: element.tagName,
      tagOrdinal: getTagOrdinal(element),
      offsetRatio
    };
  }

  function findTargetFromAnchor(anchor) {
    if (!anchor) {
      return null;
    }

    let element = resolveElementPath(anchor.path);
    if (element && anchor.tagName && element.tagName !== anchor.tagName) {
      element = null;
    }

    if (!element) {
      element = resolveByTagOrdinal(anchor.tagName, anchor.tagOrdinal);
    }

    return element;
  }

  function applyScroll(progress, anchor, syncId) {
    const scroller = getScroller();
    if (!scroller) {
      return;
    }

    let targetTop = null;
    const anchorElement = findTargetFromAnchor(anchor);
    if (anchorElement) {
      const rect = anchorElement.getBoundingClientRect();
      const elementTop = getDocumentTopFromRect(rect.top);
      const elementHeight = Math.max(rect.height, 1);
      const offsetRatio = Number.isFinite(anchor?.offsetRatio) ? Math.min(Math.max(anchor.offsetRatio, 0), 1) : 0;
      targetTop = Math.round(elementTop + elementHeight * offsetRatio - Math.min(ANCHOR_Y, window.innerHeight - 1));
    }

    if (targetTop == null) {
      const safeProgress = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 1) : 0;
      const max = Math.max(scroller.scrollHeight - window.innerHeight, 0);
      targetTop = Math.round(max * safeProgress);
    }

    const maxScroll = Math.max(scroller.scrollHeight - window.innerHeight, 0);
    const clampedTargetTop = Math.min(Math.max(targetTop, 0), maxScroll);

    suppressUntil = Date.now() + APPLY_SUPPRESS_MS;
    if (syncId) {
      lastAppliedSyncId = syncId;
    }
    scroller.scrollTop = clampedTargetTop;
    window.scrollTo(0, clampedTargetTop);
    lastProgress = getScrollProgress();
  }

  function sendRegister() {
    chrome.runtime.sendMessage({
      type: "REGISTER_FRAME",
      role
    });
  }

  function signalActiveSource(force = false) {
    if (Date.now() < applyingRemoteUntil) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastActiveSentAt < ACTIVE_SIGNAL_INTERVAL_MS) {
      return;
    }

    lastActiveSentAt = now;
    chrome.runtime.sendMessage({
      type: "SET_ACTIVE_SOURCE"
    });
  }

  function markUserIntent(forceActive = true) {
    if (Date.now() < applyingRemoteUntil) {
      return;
    }

    userIntentUntil = Date.now() + USER_INTENT_WINDOW_MS;
    if (forceActive) {
      signalActiveSource(true);
    }
  }

  function maybeSendScroll() {
    const now = Date.now();
    if (
      now < suppressUntil ||
      now < applyingRemoteUntil ||
      now > userIntentUntil ||
      now - lastSentAt < SEND_INTERVAL_MS
    ) {
      return;
    }

    const progress = getScrollProgress();
    if (Math.abs(progress - lastProgress) < MIN_PROGRESS_DELTA) {
      return;
    }

    lastSentAt = now;
    lastProgress = progress;

    outboundSeq += 1;
    const syncId = `${role}:${outboundSeq}:${now}`;
    chrome.runtime.sendMessage({
      type: "SCROLL",
      progress,
      anchor: buildAnchor(),
      syncId
    });
  }

  window.addEventListener("scroll", maybeSendScroll, { passive: true });
  window.addEventListener("resize", maybeSendScroll);
  window.addEventListener("focus", () => markUserIntent(true), true);
  window.addEventListener("pointerdown", () => markUserIntent(true), { passive: true });
  window.addEventListener("mousedown", () => markUserIntent(true), { passive: true });
  window.addEventListener("wheel", () => markUserIntent(true), { passive: true });
  window.addEventListener("touchstart", () => markUserIntent(true), { passive: true });
  window.addEventListener("touchmove", () => markUserIntent(false), { passive: true });
  window.addEventListener("keydown", () => markUserIntent(true), { passive: true });
  document.addEventListener("scroll", maybeSendScroll, { passive: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "APPLY_SCROLL") {
      return;
    }

    // Ignore duplicated relay packets that can happen during rapid resize/layout changes.
    if (message.syncId && message.syncId === lastAppliedSyncId) {
      return;
    }

    applyingRemoteUntil = Date.now() + APPLY_SUPPRESS_MS + 420;
    applyScroll(message.progress, message.anchor, message.syncId);
  });

  sendRegister();
  setTimeout(sendRegister, 500);
  setTimeout(sendRegister, 1500);
}
