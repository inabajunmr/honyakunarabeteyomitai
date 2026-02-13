const sessions = new Map();

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function buildTranslatedUrl(originalUrl) {
  const encoded = encodeURIComponent(originalUrl);
  return `https://translate.google.com/translate?sl=auto&tl=ja&u=${encoded}`;
}

function buildViewerUrl(originalUrl) {
  const url = new URL(chrome.runtime.getURL("viewer.html"));
  url.searchParams.set("original", originalUrl);
  url.searchParams.set("translated", buildTranslatedUrl(originalUrl));
  return url.toString();
}

function cleanupSession(tabId) {
  sessions.delete(tabId);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null || !isHttpUrl(tab.url)) {
    return;
  }

  try {
    const viewerUrl = buildViewerUrl(tab.url);
    cleanupSession(tab.id);
    await chrome.tabs.update(tab.id, { url: viewerUrl });
  } catch (error) {
    console.error("honyakunarabeteyomitai: failed to open split viewer:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || sender.tab?.id == null) {
    return;
  }

  const tabId = sender.tab.id;
  const frameId = sender.frameId;

  if (message.type === "REGISTER_FRAME") {
    if (typeof frameId !== "number" || !["original", "translated"].includes(message.role)) {
      return;
    }

    const session = sessions.get(tabId) ?? {
      originalFrameId: null,
      translatedFrameId: null,
      activeSourceFrameId: null,
      blockActiveFromFrameId: null,
      blockActiveUntil: 0
    };
    if (message.role === "original") {
      session.originalFrameId = frameId;
    } else {
      session.translatedFrameId = frameId;
    }
    sessions.set(tabId, session);
    return;
  }

  if (message.type === "SET_ACTIVE_SOURCE") {
    const session = sessions.get(tabId);
    if (!session || typeof frameId !== "number") {
      return;
    }

    const isKnownFrame = frameId === session.originalFrameId || frameId === session.translatedFrameId;
    if (!isKnownFrame) {
      return;
    }

    const now = Date.now();
    if (
      session.blockActiveFromFrameId === frameId &&
      typeof session.blockActiveUntil === "number" &&
      now < session.blockActiveUntil
    ) {
      return;
    }

    session.activeSourceFrameId = frameId;
    sessions.set(tabId, session);
    return;
  }

  if (message.type === "SCROLL") {
    const session = sessions.get(tabId);
    if (!session || typeof frameId !== "number") {
      return;
    }

    const isOriginalSource = frameId === session.originalFrameId;
    const isTranslatedSource = frameId === session.translatedFrameId;
    if (!isOriginalSource && !isTranslatedSource) {
      return;
    }

    const targetFrameId = isOriginalSource ? session.translatedFrameId : session.originalFrameId;
    if (typeof targetFrameId !== "number") {
      return;
    }

    if (session.activeSourceFrameId == null) {
      session.activeSourceFrameId = frameId;
      sessions.set(tabId, session);
    }

    if (session.activeSourceFrameId !== frameId) {
      return;
    }

    session.blockActiveFromFrameId = targetFrameId;
    session.blockActiveUntil = Date.now() + 650;
    sessions.set(tabId, session);

    chrome.tabs.sendMessage(tabId, {
      type: "APPLY_SCROLL",
      progress: message.progress,
      anchor: message.anchor ?? null,
      syncId: message.syncId ?? null
    }, {
      frameId: targetFrameId
    }, () => {
      void chrome.runtime.lastError;
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupSession(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) {
    return;
  }

  const isViewer = typeof tab.url === "string" && tab.url.startsWith(chrome.runtime.getURL("viewer.html"));
  if (!isViewer) {
    cleanupSession(tabId);
  }
});
