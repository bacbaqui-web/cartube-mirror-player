import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { doc, getFirestore, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyBpe8c2D-Es7PFHLp67J5c_D6hdIul50ZI",
  authDomain: "tuntun-playlist.firebaseapp.com",
  projectId: "tuntun-playlist",
  storageBucket: "tuntun-playlist.firebasestorage.app",
  messagingSenderId: "761197728531",
  appId: "1:761197728531:web:ed98e3e7c22fa38fc140e6"
});

const auth = getAuth(app);
const db = getFirestore(app);
const legacyTabs = [
  { id: "songs", name: "동요", key: "songs" },
  { id: "cars", name: "자동차", key: "cars" },
  { id: "dinosaurs", name: "공룡", key: "dinosaurs" }
];
let playlistRef = null;
let tabs = legacyTabs.map(({ id, name }) => ({ id, name, videos: [] }));
let selectedTabID = "songs";
let unsubscribe = null;
let isEnrichingMetadata = false;

const authButton = document.querySelector("#authButton");
const manager = document.querySelector("#manager");
const signedOut = document.querySelector("#signedOut");
const pasteButton = document.querySelector("#pasteButton");
const status = document.querySelector("#status");
const videoList = document.querySelector("#videoList");
const emptyList = document.querySelector("#emptyList");
const tabsElement = document.querySelector("#tabs");
const addTabButton = document.querySelector("#addTabButton");
const manageTabsButton = document.querySelector("#manageTabsButton");
const tabDialog = document.querySelector("#tabDialog");
const tabList = document.querySelector("#tabList");

authButton.addEventListener("click", async () => {
  try {
    if (auth.currentUser) await signOut(auth);
    else {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      await signInWithPopup(auth, provider);
    }
  } catch (error) {
    showStatus(friendlyError(error));
  }
});

pasteButton.addEventListener("click", async () => {
  const tab = selectedTab();
  if (!tab) return;
  pasteButton.disabled = true;
  pasteButton.classList.add("loading");
  showStatus("");
  try {
    const text = await navigator.clipboard.readText();
    const videoID = parseYouTubeID(text);
    if (!videoID) throw new Error("YouTube 영상 주소를 먼저 복사해 주세요.");
    const response = await fetch(oEmbedURL(videoID));
    if (!response.ok) throw new Error("영상 제목을 가져오지 못했습니다.");
    const { title, author_name: channelName } = await response.json();
    tab.videos.push({ id: crypto.randomUUID(), videoID, title, channelName });
    await save();
    showStatus("영상이 추가되었습니다.");
  } catch (error) {
    showStatus(error.message || "영상을 추가하지 못했습니다.");
  } finally {
    pasteButton.disabled = !auth.currentUser;
    pasteButton.classList.remove("loading");
  }
});

addTabButton.addEventListener("click", async () => {
  const name = prompt("새 탭 이름")?.trim();
  if (!name) return;
  const tab = { id: crypto.randomUUID(), name, videos: [] };
  tabs.push(tab);
  selectedTabID = tab.id;
  await save();
  render();
});

manageTabsButton.addEventListener("click", () => {
  renderTabManager();
  tabDialog.showModal();
});
document.querySelector("#closeTabDialog").addEventListener("click", () => tabDialog.close());

onAuthStateChanged(auth, user => {
  pasteButton.disabled = !user;
  addTabButton.disabled = !user;
  manageTabsButton.disabled = !user;
  authButton.classList.toggle("signed-in", !!user);
  authButton.setAttribute("aria-label", user ? "로그아웃" : "Google로 로그인");
  authButton.title = user ? `${user.email || "Google 계정"} · 로그아웃` : "Google로 로그인";
  manager.hidden = !user;
  signedOut.hidden = !!user;
  unsubscribe?.();
  playlistRef = null;
  if (!user) return;
  playlistRef = doc(db, "users", user.uid, "playlists", "default");
  unsubscribe = onSnapshot(playlistRef, snapshot => {
    if (snapshot.exists()) {
      tabs = decodeTabs(snapshot.data());
      ensureSelection();
    } else {
      save().catch(error => showStatus(friendlyError(error)));
    }
    render();
    enrichMissingChannelNames();
  }, error => showStatus(friendlyError(error)));
});

function decodeTabs(data) {
  if (Array.isArray(data.tabs) && data.tabs.length) {
    return data.tabs.map(tab => ({
      id: String(tab.id || crypto.randomUUID()),
      name: String(tab.name || "이름 없는 탭"),
      videos: Array.isArray(tab.videos) ? tab.videos : []
    }));
  }
  return legacyTabs.map(({ id, name, key }) => ({
    id,
    name,
    videos: Array.isArray(data[key]) ? data[key] : []
  }));
}

async function save() {
  if (!playlistRef) throw new Error("Google 로그인이 필요합니다.");
  await setDoc(playlistRef, { tabs, updatedAt: new Date().toISOString() });
}

function selectedTab() {
  return tabs.find(tab => tab.id === selectedTabID);
}

function ensureSelection() {
  if (!selectedTab()) selectedTabID = tabs[0]?.id || "";
}

function render() {
  ensureSelection();
  tabsElement.replaceChildren(...tabs.map(tab => {
    const button = document.createElement("button");
    button.className = `tab${tab.id === selectedTabID ? " active" : ""}`;
    button.textContent = tab.name;
    button.addEventListener("click", () => {
      selectedTabID = tab.id;
      render();
    });
    return button;
  }));

  const videos = selectedTab()?.videos || [];
  videoList.replaceChildren(...videos.map((video, index) => {
    const item = document.createElement("li");
    item.className = "video";
    const youtubeURL = `https://www.youtube.com/watch?v=${video.videoID}`;
    item.innerHTML = `<a class="video-link" target="_blank" rel="noopener noreferrer"><img alt="" src="https://i.ytimg.com/vi/${video.videoID}/mqdefault.jpg"></a><a class="video-info video-link" target="_blank" rel="noopener noreferrer"><span class="video-title"></span><span class="channel-name"></span></a><div class="actions"><button class="rename" aria-label="이름 변경" title="이름 변경">✎</button><button class="delete" aria-label="삭제" title="삭제">⌫</button></div>`;
    item.querySelectorAll(".video-link").forEach(link => link.href = youtubeURL);
    item.querySelector(".video-title").textContent = `${index + 1}. ${video.title}`;
    const channel = item.querySelector(".channel-name");
    channel.textContent = video.channelName || "";
    channel.hidden = !video.channelName;
    item.querySelector(".rename").addEventListener("click", async () => {
      const title = prompt("영상 이름", video.title)?.trim();
      if (!title) return;
      video.title = title;
      await save();
    });
    item.querySelector(".delete").addEventListener("click", async () => {
      if (!confirm(`‘${video.title}’ 영상을 삭제할까요?`)) return;
      const currentTab = selectedTab();
      currentTab.videos = currentTab.videos.filter(item => item.id !== video.id);
      await save();
    });
    return item;
  }));
  emptyList.hidden = videos.length > 0;
}

function renderTabManager() {
  tabList.replaceChildren(...tabs.map((tab, index) => {
    const item = document.createElement("li");
    item.innerHTML = `<span class="managed-tab-name"></span><span class="tab-actions"><button aria-label="위로 이동" title="위로 이동">↑</button><button aria-label="아래로 이동" title="아래로 이동">↓</button><button aria-label="이름 변경" title="이름 변경">✎</button><button class="delete" aria-label="삭제" title="삭제">⌫</button></span>`;
    item.querySelector(".managed-tab-name").textContent = `${tab.name} · ${tab.videos.length}개`;
    const buttons = item.querySelectorAll("button");
    buttons[0].disabled = index === 0;
    buttons[0].addEventListener("click", () => moveTab(index, index - 1));
    buttons[1].disabled = index === tabs.length - 1;
    buttons[1].addEventListener("click", () => moveTab(index, index + 1));
    buttons[2].addEventListener("click", async () => {
      const name = prompt("탭 이름", tab.name)?.trim();
      if (!name) return;
      tab.name = name;
      await save();
      render();
      renderTabManager();
    });
    buttons[3].disabled = tabs.length <= 1;
    buttons[3].addEventListener("click", async () => {
      if (!confirm(`‘${tab.name}’ 탭과 안의 영상 ${tab.videos.length}개를 모두 삭제할까요?`)) return;
      tabs = tabs.filter(item => item.id !== tab.id);
      ensureSelection();
      await save();
      render();
      renderTabManager();
    });
    return item;
  }));
}

async function moveTab(from, to) {
  if (to < 0 || to >= tabs.length) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  await save();
  render();
  renderTabManager();
}

async function enrichMissingChannelNames() {
  if (isEnrichingMetadata || !playlistRef) return;
  const missing = tabs.flatMap(tab => tab.videos.filter(video => !video.channelName));
  if (!missing.length) return;
  isEnrichingMetadata = true;
  let changed = false;
  try {
    for (const video of missing) {
      const response = await fetch(oEmbedURL(video.videoID));
      if (!response.ok) continue;
      const { author_name: channelName } = await response.json();
      if (channelName) {
        video.channelName = channelName;
        changed = true;
      }
    }
    if (changed) await save();
  } finally {
    isEnrichingMetadata = false;
  }
}

function oEmbedURL(videoID) {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoID}`)}&format=json`;
}

function showStatus(message) { status.textContent = message; }

function friendlyError(error) {
  if (error?.code === "auth/unauthorized-domain") return "Firebase에서 이 웹 주소의 로그인을 아직 허용하지 않았습니다.";
  if (error?.code === "permission-denied") return "이 계정에는 재생목록 수정 권한이 없습니다.";
  return error?.message || "처리 중 오류가 발생했습니다.";
}

function parseYouTubeID(text) {
  const value = text.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be" || url.hostname.endsWith(".youtu.be")) return validID(url.pathname.split("/").filter(Boolean)[0]);
    if (!(url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com"))) return null;
    const queryID = validID(url.searchParams.get("v"));
    if (queryID) return queryID;
    const parts = url.pathname.split("/").filter(Boolean);
    const marker = parts.findIndex(part => ["shorts", "embed", "live"].includes(part));
    return marker >= 0 ? validID(parts[marker + 1]) : null;
  } catch { return null; }
}

function validID(value) { return /^[A-Za-z0-9_-]{11}$/.test(value || "") ? value : null; }
