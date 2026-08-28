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
const playlistRef = doc(db, "playlists", "default");
const categoryKeys = ["songs", "cars", "dinosaurs"];
let selectedCategory = "songs";
let playlists = Object.fromEntries(categoryKeys.map(key => [key, []]));
let unsubscribe = null;

const authButton = document.querySelector("#authButton");
const manager = document.querySelector("#manager");
const signedOut = document.querySelector("#signedOut");
const pasteButton = document.querySelector("#pasteButton");
const pasteLabel = document.querySelector("#pasteLabel");
const status = document.querySelector("#status");
const videoList = document.querySelector("#videoList");
const emptyList = document.querySelector("#emptyList");
const syncDot = document.querySelector("#syncDot");
const syncLabel = document.querySelector("#syncLabel");

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

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    selectedCategory = button.dataset.category;
    document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab === button));
    render();
  });
});

pasteButton.addEventListener("click", async () => {
  pasteButton.disabled = true;
  pasteLabel.textContent = "영상 정보를 가져오는 중…";
  showStatus("");
  try {
    const text = await navigator.clipboard.readText();
    const videoID = parseYouTubeID(text);
    if (!videoID) throw new Error("YouTube 영상 주소를 먼저 복사해 주세요.");
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoID}`)}&format=json`);
    if (!response.ok) throw new Error("영상 제목을 가져오지 못했습니다.");
    const { title } = await response.json();
    playlists[selectedCategory].push({ id: crypto.randomUUID(), videoID, title });
    await save();
    showStatus("영상이 추가되었습니다.");
  } catch (error) {
    showStatus(error.message || "영상을 추가하지 못했습니다.");
  } finally {
    pasteButton.disabled = false;
    pasteLabel.textContent = "YouTube 영상 URL 붙여넣기";
  }
});

onAuthStateChanged(auth, user => {
  authButton.textContent = user ? "로그아웃" : "Google로 로그인";
  manager.hidden = !user;
  signedOut.hidden = !!user;
  unsubscribe?.();
  if (!user) {
    setSyncState("waiting", "Google 로그인이 필요합니다");
    return;
  }
  setSyncState("waiting", "Firebase 연결 중…");
  unsubscribe = onSnapshot(playlistRef, snapshot => {
    if (snapshot.exists()) {
      const data = snapshot.data();
      playlists = Object.fromEntries(categoryKeys.map(key => [key, Array.isArray(data[key]) ? data[key] : []]));
      setSyncState("connected", "아이폰 앱과 연결됨");
    } else {
      save().then(() => setSyncState("connected", "아이폰 앱과 연결됨"))
        .catch(error => {
          setSyncState("error", "Firebase 저장 실패");
          showStatus(friendlyError(error));
        });
    }
    render();
  }, error => {
    setSyncState("error", "Firebase 연결 실패");
    showStatus(friendlyError(error));
  });
});

async function save() {
  setSyncState("waiting", "저장 중…");
  await setDoc(playlistRef, { ...playlists, updatedAt: new Date().toISOString() });
  setSyncState("connected", "아이폰 앱과 연결됨");
}

function render() {
  const videos = playlists[selectedCategory] || [];
  videoList.replaceChildren(...videos.map((video, index) => {
    const item = document.createElement("li");
    item.className = "video";
    item.innerHTML = `<img alt="" src="https://i.ytimg.com/vi/${video.videoID}/mqdefault.jpg"><div class="video-title"></div><div class="actions"><button class="rename">이름 변경</button><button class="delete">삭제</button></div>`;
    item.querySelector(".video-title").textContent = `${index + 1}. ${video.title}`;
    item.querySelector(".rename").addEventListener("click", async () => {
      const title = prompt("영상 이름", video.title)?.trim();
      if (!title) return;
      video.title = title;
      await save();
    });
    item.querySelector(".delete").addEventListener("click", async () => {
      if (!confirm(`‘${video.title}’ 영상을 삭제할까요?`)) return;
      playlists[selectedCategory] = playlists[selectedCategory].filter(item => item.id !== video.id);
      await save();
    });
    return item;
  }));
  emptyList.hidden = videos.length > 0;
}

function showStatus(message) { status.textContent = message; }

function setSyncState(state, message) {
  syncDot.className = `sync-dot ${state === "waiting" ? "" : state}`;
  syncLabel.textContent = message;
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

function validID(value) { return /^[A-Za-z0-9_-]{11}$/.test(value || "") ? value : null; }
