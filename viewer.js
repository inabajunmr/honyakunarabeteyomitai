const params = new URLSearchParams(location.search);
const original = params.get("original");
const translated = params.get("translated");

const originalFrame = document.getElementById("originalFrame");
const translatedFrame = document.getElementById("translatedFrame");
const notice = document.getElementById("notice");

function showNotice(text) {
  notice.textContent = text;
  notice.classList.add("show");
  setTimeout(() => {
    notice.classList.remove("show");
  }, 3200);
}

if (!original || !translated) {
  const p = document.createElement("p");
  p.style.padding = "16px";
  p.textContent = "URL パラメータが不正です。";
  document.body.innerHTML = "";
  document.body.appendChild(p);
} else {
  originalFrame.src = original;
  translatedFrame.src = translated;

  let originalLoaded = false;
  let translatedLoaded = false;

  originalFrame.addEventListener("load", () => {
    originalLoaded = true;
  });
  translatedFrame.addEventListener("load", () => {
    translatedLoaded = true;
  });

  setTimeout(() => {
    if (!originalLoaded || !translatedLoaded) {
      showNotice("一部ページは iframe 表示が拒否される場合があります（X-Frame-Options/CSP）。");
    }
  }, 4500);
}
