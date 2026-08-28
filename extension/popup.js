const statusEl = document.getElementById("status");
const urlInput = document.getElementById("url");
const sendBtn = document.getElementById("send");

function setStatus(s) {
  statusEl.textContent = s;
  statusEl.className = s;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (r) => {
    if (r && r.status) setStatus(r.status);
  });
}

sendBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;
  sendBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "send", url, title: "", referer: "" }, (r) => {
    sendBtn.disabled = false;
    if (r && r.ok) {
      urlInput.value = "";
      setStatus("sent ✓");
    } else {
      setStatus("error: " + ((r && r.error) || "unknown"));
    }
  });
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendBtn.click();
});

refresh();
