import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, query, where, orderBy, limit, getDoc, getDocs, setDoc, deleteDoc, onSnapshot } from 'firebase/firestore';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyBlyPb7YmgCpIIchCVP7u96eN3xU3c58s8",
  authDomain: "cairn-8a059.firebaseapp.com",
  projectId: "cairn-8a059",
  storageBucket: "cairn-8a059.firebasestorage.app",
  messagingSenderId: "43570680910",
  appId: "1:43570680910:web:cef4606b255c940c919f1f"
};
const ALLOWED_EMAIL = 'jakebentley0330@gmail.com';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

const wrapDoc = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data() });
const wrapQ = (qs) => ({ docs: qs.docs.map(wrapDoc), size: qs.size, empty: qs.empty });

function docRef(path){
  const r = doc(fs, path);
  return {
    id: r.id, path,
    get: async () => wrapDoc(await getDoc(r)),
    set: async (d) => { await setDoc(r, d); },
    update: async (d) => { await setDoc(r, d, { merge: true }); },
    delete: async () => { await deleteDoc(r); },
    onSnapshot: (cb, err) => onSnapshot(r, s => cb(wrapDoc(s)), err || (e => console.warn('doc snapshot', e))),
    collection: (c) => coll(path + '/' + c)
  };
}

function coll(name, filters = [], ord = null, lim = null){
  const build = () => {
    const wf = filters.map(([f, o, v]) => where(f, o, v));
    const whereFields = filters.map(f => f[0]);
    // Ordering by a field that is not part of the filters needs a composite index; sort client-side instead.
    const clientSort = ord && filters.length && !whereFields.includes(ord[0]);
    const cs = [...wf];
    if (ord && !clientSort) cs.push(orderBy(ord[0], ord[1] || 'asc'));
    if (lim && !clientSort) cs.push(limit(lim));
    return { q: query(collection(fs, name), ...cs), clientSort };
  };
  const post = (qs) => {
    const { clientSort } = build();
    let docs = qs.docs.map(wrapDoc);
    if (clientSort){
      const dir = ord[1] === 'desc' ? -1 : 1;
      docs.sort((a, b) => { const x = a.data()[ord[0]], y = b.data()[ord[0]]; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      if (lim) docs = docs.slice(0, lim);
    }
    return { docs, size: docs.length, empty: !docs.length };
  };
  return {
    where: (f, o, v) => coll(name, filters.concat([[f, o, v]]), ord, lim),
    orderBy: (f, d) => coll(name, filters, [f, d || 'asc'], lim),
    limit: (n) => coll(name, filters, ord, n),
    get: async () => post(await getDocs(build().q)),
    onSnapshot: (cb, err) => onSnapshot(build().q, s => cb(post(s)), err || (e => console.warn('query snapshot', e))),
    doc: (id) => docRef(name + '/' + id)
  };
}

const dbApi = { doc: docRef, collection: (c) => coll(c) };

/* ---- sign-in gate ---- */
function gateEl(){
  let g = document.getElementById('gate');
  if (g) return g;
  g = document.createElement('div');
  g.id = 'gate';
  g.innerHTML = '<div class="gatebox"><div id="gateLogo"></div><div class="gatetitle">Cairn</div><div class="gatesub" id="gateSub">Sign in to open your training log.</div><button id="gateBtn" class="gatebtn">Sign in with Google</button><div class="gateerr" id="gateErr"></div></div>';
  document.body.appendChild(g);
  const lg = document.getElementById('gateLogo');
  if (window.CAIRN_LOGO) lg.innerHTML = window.CAIRN_LOGO;
  return g;
}

async function startSignIn(){
  const err = document.getElementById('gateErr');
  err.textContent = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ login_hint: ALLOWED_EMAIL });
  try{
    await signInWithPopup(auth, provider);
  }catch(e){
    console.warn('popup sign-in failed', e && e.code);
    if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment' || e.code === 'auth/cancelled-popup-request')){
      try{ await signInWithRedirect(auth, provider); return; }catch(e2){ err.textContent = 'Sign-in failed: ' + (e2.code || e2.message); return; }
    }
    if (e && e.code !== 'auth/popup-closed-by-user') err.textContent = 'Sign-in failed: ' + (e.code || e.message);
  }
}

window.cairnDb = () => new Promise((resolve) => {
  let done = false;
  getRedirectResult(auth).catch(e => console.warn('redirect result', e && e.code));
  onAuthStateChanged(auth, async (user) => {
    if (user && (user.email || '').toLowerCase() !== ALLOWED_EMAIL){
      const g = gateEl(); g.style.display = 'flex';
      document.getElementById('gateSub').textContent = 'This app is private.';
      document.getElementById('gateErr').textContent = (user.email || 'That account') + ' does not have access.';
      document.getElementById('gateBtn').textContent = 'Use a different account';
      document.getElementById('gateBtn').onclick = async () => { await signOut(auth); startSignIn(); };
      return;
    }
    if (user){
      const g = document.getElementById('gate'); if (g) g.style.display = 'none';
      if (!done){ done = true; resolve(dbApi); }
      return;
    }
    const g = gateEl(); g.style.display = 'flex';
    document.getElementById('gateBtn').onclick = startSignIn;
  });
});
window.cairnSignOut = () => signOut(auth).then(() => location.reload());
window.cairnUser = () => auth.currentUser;
