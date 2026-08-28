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
let pendingImportedPlaylist = null;
let youtubeAPIReadyPromise = null;

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
const playlistDialog = document.querySelector("#playlistDialog");
const playlistSummary = document.querySelector("#playlistSummary");
const toast = document.querySelector("#toast");
let toastTimer = null;

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
    const playlistID = parsePlaylistID(text);
    if (playlistID) {
      pendingImportedPlaylist = await importYouTubePlaylist(playlistID);
      playlistSummary.textContent = `영상 ${pendingImportedPlaylist.videos.length}개를 가져왔습니다. 어디에 추가할까요?`;
      playlistDialog.showModal();
      return;
    }
    const videoID = parseYouTubeID(text);
    if (!videoID) throw new Error("YouTube 영상 주소를 먼저 복사해 주세요.");
    const [response, durationSeconds] = await Promise.all([
      fetch(oEmbedURL(videoID)),
      loadVideoDuration(videoID)
    ]);
    if (!response.ok) throw new Error("영상 제목을 가져오지 못했습니다.");
    const { title, author_name: channelName } = await response.json();
    tab.videos.push({ id: crypto.randomUUID(), videoID, title, channelName, durationSeconds });
    await save();
    showToast("영상이 추가되었습니다");
  } catch (error) {
    showStatus(error.message || "영상을 추가하지 못했습니다.");
  } finally {
    pasteButton.disabled = !auth.currentUser;
    pasteButton.classList.remove("loading");
  }
});

document.querySelector("#addPlaylistCurrent").addEventListener("click", async () => {
  if (!pendingImportedPlaylist) return;
  const count = pendingImportedPlaylist.videos.length;
  selectedTab().videos.push(...pendingImportedPlaylist.videos);
  closePlaylistDialog();
  await save();
  showToast(`영상 ${count}개가 추가되었습니다`);
});

document.querySelector("#addPlaylistNew").addEventListener("click", async () => {
  if (!pendingImportedPlaylist) return;
  const name = prompt("새 탭 이름", "YouTube 재생목록")?.trim();
  if (!name) return;
  const count = pendingImportedPlaylist.videos.length;
  const tab = { id: crypto.randomUUID(), name, videos: pendingImportedPlaylist.videos };
  tabs.push(tab);
  selectedTabID = tab.id;
  closePlaylistDialog();
  await save();
  render();
  showToast(`새 탭에 영상 ${count}개가 추가되었습니다`);
});

document.querySelector("#cancelPlaylist").addEventListener("click", closePlaylistDialog);

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
    enrichMissingMetadata();
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
    item.innerHTML = `<a class="video-link thumbnail-wrap" target="_blank" rel="noopener noreferrer"><img alt="" src="https://i.ytimg.com/vi/${video.videoID}/mqdefault.jpg"><span class="duration-badge" hidden></span></a><a class="video-info video-link" target="_blank" rel="noopener noreferrer"><span class="video-title"></span><span class="channel-name"></span></a><div class="actions"><button class="rename" aria-label="이름 변경" title="이름 변경">✎</button><button class="delete" aria-label="삭제" title="삭제">⌫</button></div>`;
    item.querySelectorAll(".video-link").forEach(link => link.href = youtubeURL);
    item.querySelector(".video-title").textContent = `${index + 1}. ${video.title}`;
    const channel = item.querySelector(".channel-name");
    channel.textContent = video.channelName || "";
    channel.hidden = !video.channelName;
    const duration = item.querySelector(".duration-badge");
    duration.textContent = formatDuration(video.durationSeconds);
    duration.hidden = !video.durationSeconds;
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

async function enrichMissingMetadata() {
  if (isEnrichingMetadata || !playlistRef) return;
  const missing = tabs.flatMap(tab => tab.videos.filter(video => !video.channelName || !video.durationSeconds));
  if (!missing.length) return;
  isEnrichingMetadata = true;
  let changed = false;
  try {
    for (const video of missing) {
      if (!video.channelName) {
        const response = await fetch(oEmbedURL(video.videoID));
        if (response.ok) {
          const { author_name: channelName } = await response.json();
          if (channelName) video.channelName = channelName;
        }
      }
      if (!video.durationSeconds) {
        video.durationSeconds = await loadVideoDuration(video.videoID);
      }
      if (video.channelName || video.durationSeconds) {
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

function closePlaylistDialog() {
  playlistDialog.close();
  pendingImportedPlaylist = null;
}

async function importYouTubePlaylist(playlistID) {
  const videoIDs = await loadPlaylistVideoIDs(playlistID);
  if (!videoIDs.length) throw new Error("공개 재생목록의 영상을 가져오지 못했습니다.");

  const videos = (await mapWithConcurrency(videoIDs, 4, async videoID => {
    try {
      const [response, durationSeconds] = await Promise.all([
        fetch(oEmbedURL(videoID)),
        loadVideoDuration(videoID)
      ]);
      if (!response.ok) return null;
      const { title, author_name: channelName } = await response.json();
      return { id: crypto.randomUUID(), videoID, title, channelName, durationSeconds };
    } catch {
      return null;
    }
  })).filter(Boolean);
  if (!videos.length) throw new Error("재생목록의 영상 정보를 가져오지 못했습니다.");
  return { videos };
}

async function mapWithConcurrency(values, limit, transform) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await transform(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

async function loadVideoDuration(videoID) {
  await loadYouTubeIframeAPI();
  return new Promise(resolve => {
    const host = document.querySelector("#youtubePlaylistLoader");
    const target = document.createElement("div");
    host.append(target);
    let player;
    let finished = false;
    const finish = seconds => {
      if (finished) return;
      finished = true;
      player?.destroy();
      target.remove();
      resolve(seconds > 0 ? Math.round(seconds) : null);
    };
    const timeout = setTimeout(() => finish(null), 10000);
    player = new YT.Player(target, {
      width: "2",
      height: "2",
      videoId: videoID,
      playerVars: { autoplay: 0, controls: 0 },
      events: {
        onReady: event => {
          setTimeout(() => {
            clearTimeout(timeout);
            finish(event.target.getDuration());
          }, 250);
        },
        onError: () => {
          clearTimeout(timeout);
          finish(null);
        }
      }
    });
  });
}

async function loadPlaylistVideoIDs(playlistID) {
  await loadYouTubeIframeAPI();
  return new Promise((resolve, reject) => {
    const host = document.querySelector("#youtubePlaylistLoader");
    const target = document.createElement("div");
    host.replaceChildren(target);
    let player;
    const timeout = setTimeout(() => {
      player?.destroy();
      reject(new Error("재생목록을 불러오는 시간이 초과되었습니다."));
    }, 15000);
    player = new YT.Player(target, {
      width: "2",
      height: "2",
      playerVars: { listType: "playlist", list: playlistID, autoplay: 0, controls: 0 },
      events: {
        onReady: event => {
          setTimeout(() => {
            const ids = [...new Set(event.target.getPlaylist() || [])];
            clearTimeout(timeout);
            event.target.destroy();
            if (ids.length) resolve(ids);
            else reject(new Error("공개 재생목록의 영상을 찾지 못했습니다."));
          }, 500);
        },
        onError: () => {
          clearTimeout(timeout);
          player?.destroy();
          reject(new Error("공개 재생목록을 불러오지 못했습니다."));
        }
      }
    });
  });
}

function loadYouTubeIframeAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (youtubeAPIReadyPromise) return youtubeAPIReadyPromise;
  youtubeAPIReadyPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => reject(new Error("YouTube 재생목록 기능을 불러오지 못했습니다."));
    document.head.append(script);
  });
  return youtubeAPIReadyPromise;
}

function showStatus(message) { status.textContent = message; }

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2000);
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "";
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remaining = whole % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

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

function parsePlaylistID(text) {
  try {
    const url = new URL(text.trim());
    const isYouTube = url.hostname === "youtu.be" || url.hostname.endsWith(".youtu.be") || url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com");
    return isYouTube ? url.searchParams.get("list") : null;
  } catch { return null; }
}

function validID(value) { return /^[A-Za-z0-9_-]{11}$/.test(value || "") ? value : null; }
