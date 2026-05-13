const state = {
  user: null,
  limits: { freeQuestions: 10, freeDocuments: 6 },
  documents: [],
  citations: [],
  selectedCitationId: null,
  authMode: 'login',
  lastQuestion: ''
};

const el = {
  toast: document.getElementById('toast'),
  authView: document.getElementById('authView'),
  appView: document.getElementById('appView'),
  authForm: document.getElementById('authForm'),
  authSubmit: document.getElementById('authSubmit'),
  authMode: document.getElementById('authMode'),
  emailInput: document.getElementById('emailInput'),
  passwordInput: document.getElementById('passwordInput'),
  usagePill: document.getElementById('usagePill'),
  planPill: document.getElementById('planPill'),
  premiumButton: document.getElementById('premiumButton'),
  logoutButton: document.getElementById('logoutButton'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  uploadStatus: document.getElementById('uploadStatus'),
  documentCount: document.getElementById('documentCount'),
  documentsList: document.getElementById('documentsList'),
  askForm: document.getElementById('askForm'),
  questionInput: document.getElementById('questionInput'),
  askButton: document.getElementById('askButton'),
  providerLabel: document.getElementById('providerLabel'),
  answerMeta: document.getElementById('answerMeta'),
  answerBox: document.getElementById('answerBox'),
  citationScore: document.getElementById('citationScore'),
  citationBox: document.getElementById('citationBox'),
  citationList: document.getElementById('citationList'),
  paywall: document.getElementById('paywall'),
  paywallMessage: document.getElementById('paywallMessage'),
  closePaywall: document.getElementById('closePaywall'),
  checkoutButton: document.getElementById('checkoutButton')
};

boot();

async function boot() {
  bindEvents();
  const params = new URLSearchParams(location.search);
  if (params.get('billing')) showToast('Retorno do Mercado Pago recebido. Se o pagamento estiver aprovado, o premium ativa automaticamente.');
  if (params.get('billing') === 'cancel') showToast('Checkout cancelado.');

  try {
    const data = await api('/api/me');
    state.user = data.user;
    state.limits = data.limits || state.limits;
    renderSession();
    if (state.user) {
      await syncBilling();
      await loadDocuments();
    }
  } catch (error) {
    showToast(error.message);
    renderSession();
  }
}

function bindEvents() {
  el.authForm.addEventListener('submit', onAuthSubmit);
  el.authMode.addEventListener('click', () => {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    renderAuthMode();
  });

  el.logoutButton.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.documents = [];
    state.citations = [];
    renderSession();
  });

  el.premiumButton.addEventListener('click', () => openPaywall('Ative o premium para remover os limites da demo.'));
  el.closePaywall.addEventListener('click', () => {
    el.paywall.hidden = true;
  });
  el.checkoutButton.addEventListener('click', startCheckout);

  el.fileInput.addEventListener('change', () => uploadFiles([...el.fileInput.files]));
  el.dropzone.addEventListener('dragover', (event) => {
    event.preventDefault();
    el.dropzone.classList.add('dragging');
  });
  el.dropzone.addEventListener('dragleave', () => {
    el.dropzone.classList.remove('dragging');
  });
  el.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    el.dropzone.classList.remove('dragging');
    uploadFiles([...event.dataTransfer.files]);
  });

  el.askForm.addEventListener('submit', onAsk);
}

async function onAuthSubmit(event) {
  event.preventDefault();
  const email = el.emailInput.value.trim();
  const password = el.passwordInput.value;
  const path = state.authMode === 'login' ? '/api/auth/login' : '/api/auth/register';

  el.authSubmit.disabled = true;
  el.authSubmit.classList.add('loading');
  try {
    const data = await api(path, {
      method: 'POST',
      body: { email, password }
    });
    state.user = data.user;
    state.limits = data.limits || state.limits;
    renderSession();
    await loadDocuments();
  } catch (error) {
    showToast(error.message);
  } finally {
    el.authSubmit.disabled = false;
    el.authSubmit.classList.remove('loading');
  }
}

async function loadDocuments() {
  const data = await api('/api/documents');
  state.documents = data.documents || [];
  renderDocuments();
  renderUser();
}

async function uploadFiles(files) {
  const pdfs = files.filter((file) => file.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) {
    showToast('Selecione pelo menos um PDF.');
    return;
  }

  const body = new FormData();
  for (const file of pdfs) body.append('documents', file);

  el.uploadStatus.textContent = `Processando ${pdfs.length} arquivo(s)...`;
  try {
    const data = await api('/api/documents', { method: 'POST', body, form: true });
    state.user = data.user || state.user;
    await loadDocuments();
    const warnings = (data.documents || []).filter((doc) => doc.warning).length;
    el.uploadStatus.textContent = warnings ? `${warnings} arquivo(s) com aviso.` : 'Upload concluido.';
  } catch (error) {
    if (error.status === 402) openPaywall(error.message);
    else showToast(error.message);
    el.uploadStatus.textContent = '';
  } finally {
    el.fileInput.value = '';
  }
}

async function onAsk(event) {
  event.preventDefault();
  const question = el.questionInput.value.trim();
  if (!question) return;

  state.lastQuestion = question;
  el.askButton.disabled = true;
  el.askButton.classList.add('loading');
  el.answerMeta.textContent = 'Buscando';
  el.answerMeta.classList.add('loading');
  el.answerBox.className = 'answer-box loading';
  el.answerBox.textContent = '';
  state.citations = [];
  state.selectedCitationId = null;
  el.citationList.innerHTML = '';
  el.citationScore.textContent = '—';
  el.citationBox.className = 'citation-box loading';
  el.citationBox.textContent = '';

  try {
    const data = await api('/api/ask', {
      method: 'POST',
      body: { question }
    });
    state.user = data.user || state.user;
    state.citations = data.citations || [];
    state.selectedCitationId = pickInitialCitation(data.answer || '', state.citations)?.id || null;
    el.providerLabel.textContent = data.provider || 'mock';
    el.answerMeta.textContent = state.citations.length ? `${state.citations.length} trecho(s)` : 'Sem trecho';
    el.answerBox.className = 'answer-box';
    el.answerBox.textContent = data.answer || '';
    if (data.warning) showToast(data.warning);
    renderUser();
    renderCitations();
  } catch (error) {
    if (error.status === 402) openPaywall(error.message);
    else showToast(error.message);
    el.answerMeta.textContent = 'Erro';
    el.answerBox.className = 'answer-box';
    el.answerBox.textContent = error.message;
    el.citationBox.className = 'citation-box empty';
    el.citationBox.textContent = 'O trecho mais provavel aparece aqui com documento e pagina.';
  } finally {
    el.askButton.disabled = false;
    el.askButton.classList.remove('loading');
    el.answerMeta.classList.remove('loading');
  }
}

async function startCheckout() {
  el.checkoutButton.disabled = true;
  try {
    const data = await api('/api/billing/checkout', { method: 'POST' });
    if (data.premium) {
      el.paywall.hidden = true;
      showToast('Sua conta ja esta premium.');
      return;
    }
    if (data.preferenceId) localStorage.setItem('cf_last_preference', data.preferenceId);
    if (data.url) location.href = data.url;
  } catch (error) {
    showToast(error.message);
  } finally {
    el.checkoutButton.disabled = false;
  }
}

async function syncBilling() {
  try {
    const data = await api('/api/billing/sync', { method: 'POST' });
    if (data.user) {
      state.user = data.user;
      renderUser();
    }
  } catch {
    // Sync is best-effort; checkout/webhook can still activate the plan later.
  }
}

function renderSession() {
  const signedIn = Boolean(state.user);
  el.authView.hidden = signedIn;
  el.appView.hidden = !signedIn;
  renderAuthMode();
  if (signedIn) renderUser();
}

function renderAuthMode() {
  const isLogin = state.authMode === 'login';
  el.authSubmit.textContent = isLogin ? 'Entrar' : 'Criar conta';
  el.authMode.textContent = isLogin ? 'Criar conta de teste' : 'Ja tenho conta';
}

function renderUser() {
  if (!state.user) return;
  const usage = state.user.usage || {};
  const plan = state.user.plan || 'free';
  el.usagePill.textContent = plan === 'premium'
    ? `${usage.documents || 0} docs`
    : `${usage.questions || 0}/${state.limits.freeQuestions} perguntas`;
  el.planPill.textContent = plan === 'premium' ? 'Premium' : 'Free';
  el.planPill.classList.toggle('premium', plan === 'premium');
  el.premiumButton.hidden = plan === 'premium';
}

function renderDocuments() {
  el.documentCount.textContent = String(state.documents.length);
  el.documentsList.innerHTML = '';
  if (!state.documents.length) {
    el.documentsList.classList.add('empty');
    el.documentsList.innerHTML = '<div class="document-item"><span>Nenhum documento enviado.</span></div>';
    return;
  }

  el.documentsList.classList.remove('empty');
  for (const doc of state.documents) {
    const item = document.createElement('div');
    item.className = `document-item${doc.warning ? ' warning' : ''}`;
    const pages = doc.pageCount || 0;
    const chunks = doc.chunkCount || 0;
    const pageLabel = pages === 1 ? 'pag' : 'pags';
    const chunkLabel = chunks === 1 ? 'trecho' : 'trechos';
    const meta = `${pages} ${pageLabel} · ${chunks} ${chunkLabel}`;
    item.innerHTML = `
      <div class="document-copy">
        <strong>${escapeHtml(doc.fileName)}</strong>
        <span>${meta}${doc.warning ? ` · ${escapeHtml(doc.warning)}` : ''}</span>
      </div>
      <button class="document-delete" type="button" aria-label="Excluir ${escapeHtml(doc.fileName)}" title="Excluir documento">Excluir</button>
    `;
    item.querySelector('.document-delete').addEventListener('click', () => deleteDocument(doc));
    el.documentsList.appendChild(item);
  }
}

async function deleteDocument(doc) {
  const ok = confirm(`Excluir "${doc.fileName}"?\n\nIsso remove o PDF e os trechos indexados.`);
  if (!ok) return;

  try {
    const data = await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
    state.user = data.user || state.user;
    state.citations = [];
    state.selectedCitationId = null;
    el.answerMeta.textContent = 'Aguardando pergunta';
    el.answerBox.className = 'answer-box empty';
    el.answerBox.textContent = 'Suba um PDF e pergunte sobre clausulas, prazos, multas, pagamentos ou anexos.';
    renderCitation(null);
    await loadDocuments();
    showToast('Documento excluido.');
  } catch (error) {
    showToast(error.message);
  }
}

function renderCitations() {
  const active = state.citations.find((citation) => citation.id === state.selectedCitationId) || state.citations[0] || null;
  renderCitation(active);

  el.citationList.innerHTML = '';
  for (const citation of state.citations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `citation-item${citation.id === active?.id ? ' active' : ''}`;
    button.innerHTML = `
      <strong>${escapeHtml(citation.fileName)}</strong>
      <span>pag. ${citation.page} · ${citation.usedInAnswer ? 'citada' : 'relevancia'} ${Math.round(citation.score || 0)}</span>
    `;
    button.addEventListener('click', () => {
      state.selectedCitationId = citation.id;
      renderCitations();
    });
    el.citationList.appendChild(button);
  }
}

function renderCitation(citation) {
  if (!citation) {
    el.citationScore.textContent = '-';
    el.citationBox.className = 'citation-box empty';
    el.citationBox.textContent = 'O trecho mais provavel aparece aqui com documento e pagina.';
    el.citationList.innerHTML = '';
    return;
  }

  el.citationScore.textContent = citation.usedInAnswer
    ? 'citada'
    : `rel. ${Math.round(citation.score || 0)}`;
  el.citationBox.className = 'citation-box';
  el.citationBox.innerHTML = `
    <div class="citation-badge">Pag. ${citation.page} · ${escapeHtml(citation.fileName)}</div>
    <div class="citation-text">${highlight(escapeHtml(citation.text), state.lastQuestion)}</div>
  `;
}

function pickInitialCitation(answer, citations) {
  if (!citations.length) return null;

  const pages = [...String(answer || '').matchAll(/(?:pag(?:ina)?\.?|p[áa]g(?:ina)?\.?|p\.)\s*(\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);

  for (const page of pages) {
    const citation = citations.find((item) => Number(item.page) === page);
    if (citation) return citation;
  }

  return citations.find((citation) => citation.usedInAnswer) || citations[0];
}

function openPaywall(message) {
  el.paywallMessage.textContent = message || 'Limite gratis atingido.';
  el.paywall.hidden = false;
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {}
  };

  if (options.body !== undefined) {
    if (options.form) {
      init.body = options.body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(path, init);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(data.message || data.error || 'Erro na requisicao.');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function highlight(escapedText, query) {
  const tokens = uniqueTokens(query);
  if (!tokens.length) return escapedText;

  let html = escapedText;
  for (const token of tokens) {
    const pattern = new RegExp(`(${escapeRegExp(token)})`, 'gi');
    html = html.replace(pattern, '<mark>$1</mark>');
  }
  return html;
}

function uniqueTokens(text) {
  const stopwords = new Set(['para', 'sobre', 'entre', 'como', 'qual', 'cual', 'hay', 'tem', 'tiene', 'contrato', 'anexo']);
  return [...new Set(String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]{4,}/g) || [])]
    .filter((token) => !stopwords.has(token))
    .slice(0, 12);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4200);
}
