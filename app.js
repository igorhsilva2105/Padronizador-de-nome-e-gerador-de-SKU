// ==================== ESTADO GLOBAL ====================
let fields = [];
let selectedValues = {};
let rules = [];
let skuConfig = { fieldOrder: [], partSeparator: '_', addSuffix: true, suffixLength: 3, uppercase: true };
let skuConditionalRules = [];
let nextFieldId = 1;
let nextRuleId = 1;
let systemLogs = [];
let batchResults = [];
let skuBatchResults = [];
let generationHistory = [];
let pendingSuggestions = [];
let pendingBatchImportData = null;
let batchProcessingCancel = false;
let skuBatchProcessingCancel = false;
const CHUNK_SIZE = 100;

// ==================== FUNÇÕES AUXILIARES ====================
function evaluateCondition(operator, currentValue, expectedValue) {
  if (!currentValue) currentValue = '';
  switch (operator) {
    case 'eq': return currentValue === expectedValue;
    case 'neq': return currentValue !== expectedValue;
    case 'contains': return currentValue.toLowerCase().includes(expectedValue.toLowerCase());
    default: return false;
  }
}
function isConditionMet(condition, selection) {
  if (condition.type === 'simple') {
    const s = condition.simple;
    const val = selection[s.sourceFieldId] || '';
    return evaluateCondition(s.operator || 'eq', val, s.sourceValue);
  } else {
    const c = condition.compound;
    const leftVal = selection[c.sourceFieldId1] || '';
    const rightVal = selection[c.sourceFieldId2] || '';
    const leftOk = evaluateCondition(c.operator1 || 'eq', leftVal, c.sourceValue1);
    const rightOk = evaluateCondition(c.operator2 || 'eq', rightVal, c.sourceValue2);
    return c.logic === 'AND' ? leftOk && rightOk : leftOk || rightOk;
  }
}
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}
function showToast(msg, err = false) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  const inner = toast.children[0];
  inner.classList.remove('bg-red-500/90', 'bg-gray-800/90');
  inner.classList.add(err ? 'bg-red-500/90' : 'bg-gray-800/90');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}
function saveToLocalStorage() {
  localStorage.setItem('product_padronizer', JSON.stringify({ fields, selectedValues, rules, nextFieldId, nextRuleId, skuConfig, skuConditionalRules }));
}
function loadFromLocalStorage() {
  const raw = localStorage.getItem('product_padronizer');
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    fields = data.fields || [];
    selectedValues = data.selectedValues || {};
    rules = data.rules || [];
    nextFieldId = data.nextFieldId || 1;
    nextRuleId = data.nextRuleId || 1;
    if (data.skuConfig) skuConfig = data.skuConfig;
    skuConditionalRules = data.skuConditionalRules || [];
    return true;
  } catch (e) { return false; }
}
function initDefaultData() {
  if (fields.length === 0) {
    fields = [
      { id: 'field_1', label: 'Produto', values: ['Tela Alambrado', 'Tela Hexagonal', 'Rede de Proteção', 'Corda'] },
      { id: 'field_2', label: 'Tipo', values: ['Losango', 'Quadrada', 'Trançada', 'Soldada', 'Padrão'] },
      { id: 'field_3', label: 'Fio', values: ['10', '12', '14', '16', '18', '2 mm'] },
      { id: 'field_4', label: 'Altura', values: ['1.00m', '1.20m', '1.50m', '1.80m', '2.00m'] },
      { id: 'field_5', label: 'Metragem', values: ['10m', '25m', '50m', '100m'] }
    ];
    nextFieldId = 6;
    fields.forEach(f => { if (f.values.length) selectedValues[f.id] = f.values[0]; });
    skuConfig = { fieldOrder: fields.map(f => f.id), partSeparator: '_', addSuffix: true, suffixLength: 3, uppercase: true };
  }
}
function addLog(action, details) {
  const logEntry = { id: Date.now() + '_' + Math.random().toString(36).substr(2, 6), timestamp: new Date().toISOString(), action, details };
  systemLogs.unshift(logEntry);
  if (systemLogs.length > 500) systemLogs = systemLogs.slice(0, 500);
  localStorage.setItem('product_padronizer_logs', JSON.stringify(systemLogs));
}
function loadLogsFromLocalStorage() {
  const raw = localStorage.getItem('product_padronizer_logs');
  if (raw) try { systemLogs = JSON.parse(raw); } catch (e) { }
}
function addToHistory(content, type) {
  if (!content || content === "(vazio)" || content === "Aguardando entrada..." || content.includes("Selecione")) return;
  generationHistory.unshift({ id: Date.now() + '_' + Math.random().toString(36).substr(2, 4), content, type, timestamp: new Date().toISOString() });
  if (generationHistory.length > 10) generationHistory = generationHistory.slice(0, 10);
  localStorage.setItem('generation_history', JSON.stringify(generationHistory));
}
function loadHistoryFromLocalStorage() {
  const raw = localStorage.getItem('generation_history');
  if (raw) try { generationHistory = JSON.parse(raw); } catch (e) { }
}
function cleanInvalidRules() { /* stub - pode ser implementada se necessário */ }
function refreshAll() {
  renderGeneratorFields();
  saveToLocalStorage();
}

// ==================== SUGESTÕES ====================
function extractFragments(rawText, matchedValues) {
  let text = rawText;
  for (const match of matchedValues) {
    const regex = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(regex, '');
  }
  let fragments = text.split(/[\s,;]+/).filter(t => t.length > 2).map(t => t.trim());
  return [...new Set(fragments)];
}
function collectUniqueFragmentsFromNames(rawNames) {
  const allFragments = new Set();
  for (const raw of rawNames) {
    const lowerMain = raw.toLowerCase();
    const matchedValues = [];
    for (const field of fields) {
      for (const val of field.values) {
        if (lowerMain.includes(val.toLowerCase())) {
          matchedValues.push(val);
          break;
        }
      }
    }
    const fragments = extractFragments(raw, matchedValues);
    fragments.forEach(f => allFragments.add(f));
  }
  return Array.from(allFragments);
}
async function autoFillWithSuggestions() {
  const rawText = document.getElementById('raw-product-name').value.trim();
  if (!rawText) { showToast("Cole um nome de produto primeiro", true); return; }
  let mainText = rawText, observation = "";
  const parenMatch = rawText.match(/\(([^)]+)\)\s*$/);
  if (parenMatch) {
    observation = parenMatch[1].trim();
    mainText = rawText.substring(0, parenMatch.index).trim();
  }
  const lowerMain = mainText.toLowerCase();
  const matchedValues = [];
  const newSelections = { ...selectedValues };
  for (const field of fields) {
    let bestMatch = null, bestLength = -1;
    for (const val of field.values) {
      const lowerVal = val.toLowerCase();
      if (lowerMain.includes(lowerVal) && lowerVal.length > bestLength) {
        bestMatch = val;
        bestLength = lowerVal.length;
      }
    }
    if (bestMatch) {
      newSelections[field.id] = bestMatch;
      matchedValues.push(bestMatch);
    }
  }
  const fragments = extractFragments(mainText, matchedValues);
  if (fragments.length === 0) {
    Object.assign(selectedValues, newSelections);
    if (observation) document.getElementById('input-obs').value = observation;
    saveToLocalStorage();
    refreshAll();
    addLog('auto_fill', `Auto-preenchido: "${rawText}"`);
    showToast("Auto-preenchido com sucesso");
    return;
  }
  pendingSuggestions = fragments.map(frag => ({ fragment: frag, action: 'ignore', targetFieldId: null, newFieldName: frag }));
  renderSuggestionsModal();
  window._tempAutoData = { newSelections, observation, fragments };
  document.getElementById('suggestions-modal').classList.remove('hidden');
}
function renderSuggestionsModal() {
  const container = document.getElementById('suggestions-list');
  if (!container) return;
  container.innerHTML = '';
  pendingSuggestions.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = "suggestion-item p-3 border border-gray-200 rounded-xl";
    div.innerHTML = `<div class="font-medium text-gray-800 mb-2">🔍 "${item.fragment}"</div>
      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2 text-sm"><input type="radio" name="action_${idx}" value="ignore" ${item.action === 'ignore' ? 'checked' : ''}> Ignorar</label>
        <div class="flex items-center gap-2 flex-wrap">
          <label class="flex items-center gap-2 text-sm"><input type="radio" name="action_${idx}" value="add_to_field" ${item.action === 'add_to_field' ? 'checked' : ''}> Adicionar ao campo:</label>
          <select id="targetField_${idx}" class="border rounded-lg p-1 text-sm" ${item.action !== 'add_to_field' ? 'disabled' : ''}>
            ${fields.map(f => `<option value="${f.id}" ${item.targetFieldId === f.id ? 'selected' : ''}>${f.label}</option>`).join('')}
          </select>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <label class="flex items-center gap-2 text-sm"><input type="radio" name="action_${idx}" value="new_field" ${item.action === 'new_field' ? 'checked' : ''}> Criar novo campo:</label>
          <input type="text" id="newFieldName_${idx}" value="${escapeHtml(item.newFieldName)}" class="border rounded p-1 text-sm w-40" ${item.action !== 'new_field' ? 'disabled' : ''}>
        </div>
      </div>`;
    const radios = div.querySelectorAll(`input[name="action_${idx}"]`);
    const selectField = div.querySelector(`select`);
    const inputNewField = div.querySelector(`input[type="text"]`);
    radios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        const action = e.target.value;
        pendingSuggestions[idx].action = action;
        if (action === 'add_to_field') {
          selectField.disabled = false;
          inputNewField.disabled = true;
          pendingSuggestions[idx].targetFieldId = selectField.value;
        } else if (action === 'new_field') {
          selectField.disabled = true;
          inputNewField.disabled = false;
          pendingSuggestions[idx].newFieldName = inputNewField.value;
        } else {
          selectField.disabled = true;
          inputNewField.disabled = true;
        }
      });
    });
    selectField.addEventListener('change', (e) => {
      if (pendingSuggestions[idx].action === 'add_to_field') pendingSuggestions[idx].targetFieldId = e.target.value;
    });
    inputNewField.addEventListener('input', (e) => {
      if (pendingSuggestions[idx].action === 'new_field') pendingSuggestions[idx].newFieldName = e.target.value;
    });
    container.appendChild(div);
  });
}
function applySuggestions() {
  for (const sug of pendingSuggestions) {
    if (sug.action === 'new_field') {
      let newLabel = sug.newFieldName.trim();
      if (!newLabel) newLabel = sug.fragment;
      const newId = `field_${nextFieldId++}`;
      fields.push({ id: newId, label: newLabel, values: [sug.fragment] });
      selectedValues[newId] = sug.fragment;
      if (skuConfig && skuConfig.fieldOrder && !skuConfig.fieldOrder.includes(newId)) skuConfig.fieldOrder.push(newId);
      addLog('field_add', `Campo "${newLabel}" criado via sugestão`);
    } else if (sug.action === 'add_to_field' && sug.targetFieldId) {
      const targetField = fields.find(f => f.id === sug.targetFieldId);
      if (targetField && !targetField.values.includes(sug.fragment)) {
        targetField.values.push(sug.fragment);
        if (!selectedValues[targetField.id]) selectedValues[targetField.id] = sug.fragment;
        addLog('value_add', `Valor "${sug.fragment}" adicionado ao campo "${targetField.label}"`);
      }
    }
  }
  saveToLocalStorage();
  refreshAll();
  if (pendingBatchImportData) {
    reprocessBatchImport();
    pendingBatchImportData = null;
    delete window._tempAutoData;
  } else if (window._tempAutoData) {
    const { newSelections, observation } = window._tempAutoData;
    Object.assign(selectedValues, newSelections);
    if (observation) document.getElementById('input-obs').value = observation;
    saveToLocalStorage();
    refreshAll();
    delete window._tempAutoData;
  }
  closeSuggestionsModal();
}
function closeSuggestionsModal() {
  document.getElementById('suggestions-modal')?.classList.add('hidden');
  pendingSuggestions = [];
}

// ==================== PADRONIZAÇÃO MANUAL ====================
function renderGeneratorFields() {
  const container = document.getElementById('generator-fields');
  if (!container) return;
  container.innerHTML = '';
  const visibleFields = fields.filter(f => isFieldVisible(f.id));
  for (const field of visibleFields) {
    let visibleValues = getVisibleValuesForField(field.id, field.values);
    if (!visibleValues.length) {
      container.appendChild(createEmptyFieldDiv(field.label));
      continue;
    }
    const groupDiv = document.createElement('div');
    groupDiv.className = "flex flex-col";
    const label = document.createElement('h3');
    label.className = "text-xs text-gray-500 uppercase ml-2 mb-2 font-semibold";
    label.textContent = field.label;
    groupDiv.appendChild(label);
    const scrollWrapper = document.createElement('div');
    scrollWrapper.className = "w-full overflow-x-auto no-scrollbar pb-1";
    const pillContainer = document.createElement('div');
    pillContainer.className = "bg-[#1E1F22] rounded-full p-1.5 inline-flex items-center gap-1 min-w-max shadow-sm";
    visibleValues.forEach(val => {
      const isSelected = selectedValues[field.id] === val;
      const btn = document.createElement('button');
      btn.className = `px-5 py-2 rounded-full text-[15px] font-medium transition-all ${isSelected ? 'bg-[#333942] text-white' : 'bg-transparent text-gray-400 hover:text-gray-200'}`;
      btn.textContent = val;
      btn.onclick = () => { toggleOption(field.id, val); };
      pillContainer.appendChild(btn);
    });
    scrollWrapper.appendChild(pillContainer);
    groupDiv.appendChild(scrollWrapper);
    container.appendChild(groupDiv);
  }
}
function createEmptyFieldDiv(label) {
  const div = document.createElement('div');
  div.className = "flex flex-col";
  div.innerHTML = `<h3 class="text-xs text-gray-500 uppercase ml-2 mb-2 font-semibold">${label}</h3><div class="bg-[#1E1F22] rounded-full p-3 text-center text-gray-300 text-sm">Sem opções</div>`;
  return div;
}
function toggleOption(fieldId, value) {
  selectedValues[fieldId] = (selectedValues[fieldId] === value) ? null : value;
  saveToLocalStorage();
  renderGeneratorFields();
  updatePreviewText();
}
function updatePreviewText() {
  const obs = document.getElementById('input-obs').value.trim();
  let parts = [];
  for (const field of fields) {
    const sel = selectedValues[field.id];
    if (sel && isFieldVisible(field.id)) parts.push(sel);
  }
  const separator = getActiveSeparator();
  let result = parts.join(separator);
  if (obs) result += ` (${obs})`;
  const previewDiv = document.getElementById('preview-container');
  if (!result) previewDiv.innerHTML = `<p id="preview-text" class="text-xl text-gray-800">Selecione as opções...</p>`;
  else previewDiv.innerHTML = `<p id="preview-text" class="text-xl font-medium text-gray-800">${escapeHtml(result)}</p>`;
}
function isFieldVisible(fieldId) {
  let visible = true;
  for (const rule of rules)
    if (isConditionMet(rule.condition, selectedValues))
      for (const action of rule.actions) {
        if (action.type === 'hide_field' && action.targetFieldId === fieldId) visible = false;
        if (action.type === 'show_field' && action.targetFieldId === fieldId) visible = true;
      }
  return visible;
}
function getVisibleValuesForField(fieldId, allValues) {
  let visible = [...allValues];
  for (const rule of rules)
    if (isConditionMet(rule.condition, selectedValues))
      for (const action of rule.actions) {
        if (action.type === 'hide_value' && action.targetFieldId === fieldId && action.targetValue)
          visible = visible.filter(v => v !== action.targetValue);
        if (action.type === 'show_value' && action.targetFieldId === fieldId && action.targetValue && !visible.includes(action.targetValue))
          visible.push(action.targetValue);
      }
  return visible;
}
function getActiveSeparator() {
  let separator = ' - ';
  for (const rule of rules)
    if (isConditionMet(rule.condition, selectedValues))
      for (const action of rule.actions)
        if (action.type === 'set_separator') separator = action.separator;
  return separator;
}
function copySingleResult() {
  const previewEl = document.getElementById('preview-text');
  if (previewEl && previewEl.innerText && !previewEl.innerText.includes("Selecione")) {
    navigator.clipboard?.writeText(previewEl.innerText);
    showToast("Copiado!");
    addToHistory(previewEl.innerText, 'label');
  } else showToast("Nada para copiar", true);
}

// ==================== BATCH PADRONIZAÇÃO ====================
async function processBatchImport() {
  const fileInput = document.getElementById('batch-import-file');
  if (!fileInput.files.length) { showToast("Selecione um arquivo", true); return; }
  const file = fileInput.files[0];
  const separator = document.getElementById('batch-csv-separator').value;
  const nameColumnIdx = parseInt(document.getElementById('batch-name-column').value) - 1;
  let rawNames = [];
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text();
      const parsed = Papa.parse(text, { delimiter: separator === '\\t' ? '\t' : separator, header: false, skipEmptyLines: true });
      rawNames = parsed.data.map(row => row[nameColumnIdx]).filter(v => v && v.trim().length > 0);
    } else if (ext === 'xlsx') {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      rawNames = rows.map(row => row[nameColumnIdx]).filter(v => v && v.trim().length > 0);
    } else if (ext === 'json') {
      const text = await file.text();
      const json = JSON.parse(text);
      if (Array.isArray(json)) rawNames = json.map(item => typeof item === 'string' ? item : item[Object.keys(item)[0]]).filter(v => v);
      else if (json.data && Array.isArray(json.data)) rawNames = json.data.map(item => typeof item === 'string' ? item : item[Object.keys(item)[0]]);
      else showToast("JSON inválido", true);
    } else { showToast("Formato não suportado", true); return; }
  } catch (e) { showToast("Erro ao ler arquivo", true); return; }
  if (!rawNames.length) { showToast("Nenhum nome encontrado", true); return; }
  const uniqueFragments = collectUniqueFragmentsFromNames(rawNames);
  if (uniqueFragments.length > 0) {
    pendingSuggestions = uniqueFragments.map(frag => ({ fragment: frag, action: 'ignore', targetFieldId: null, newFieldName: frag }));
    renderSuggestionsModal();
    pendingBatchImportData = { file, separator, nameColumnIdx, rawNames };
    document.getElementById('suggestions-modal').classList.remove('hidden');
    return;
  }
  startBatchProcessing(rawNames);
}
function reprocessBatchImport() {
  if (pendingBatchImportData) startBatchProcessing(pendingBatchImportData.rawNames);
}
function startBatchProcessing(rawNames) {
  batchResults = [];
  batchProcessingCancel = false;
  const progressArea = document.getElementById('batch-progress-area');
  progressArea.classList.remove('hidden');
  let processed = 0;
  const total = rawNames.length;
  const update = () => {
    const percent = Math.floor((processed / total) * 100);
    document.getElementById('batch-progress-bar').style.width = `${percent}%`;
    document.getElementById('batch-progress-percent').textContent = `${percent}%`;
    document.getElementById('batch-progress-text').textContent = `Processando ${processed} de ${total}...`;
    if (processed >= total) {
      progressArea.classList.add('hidden');
      displayBatchResults();
      showToast(`${total} nomes padronizados`);
    }
  };
  const processChunk = () => {
    if (batchProcessingCancel) { progressArea.classList.add('hidden'); return; }
    const limit = Math.min(processed + CHUNK_SIZE, total);
    for (let i = processed; i < limit; i++) {
      const suggested = suggestValuesFromRawName(rawNames[i]);
      const standardized = generateStandardNameFromSelection(suggested);
      batchResults.push(standardized);
      addToHistory(standardized, 'label');
    }
    processed = limit;
    update();
    if (processed < total) setTimeout(processChunk, 10);
    else { addLog('batch_import', `${total} nomes processados`); displayBatchResults(); }
  };
  processChunk();
}
function displayBatchResults() {
  const container = document.getElementById('batch-preview-container');
  if (!container) return;
  if (!batchResults.length) {
    container.innerHTML = '<p class="text-gray-400 text-sm">Nenhum arquivo processado.</p>';
    document.getElementById('copy-all-batch-btn')?.classList.add('hidden');
    return;
  }
  let html = '<div class="space-y-3">';
  batchResults.forEach((res, idx) => {
    html += `<div class="result-card flex justify-between items-center"><div class="font-medium">${escapeHtml(res)}</div><button onclick="copySpecificResult(${idx})" class="text-blue-500 p-2">📋</button></div>`;
  });
  container.innerHTML = html;
  document.getElementById('copy-all-batch-btn')?.classList.remove('hidden');
}
function copySpecificResult(idx) {
  if (batchResults[idx]) { navigator.clipboard?.writeText(batchResults[idx]); showToast("Copiado!"); }
}
function copyAllBatchResults() {
  if (!batchResults.length) return;
  const all = batchResults.join("\n");
  navigator.clipboard?.writeText(all);
  showToast(`${batchResults.length} resultados copiados`);
}
function suggestValuesFromRawName(rawName) {
  const normalized = rawName.toLowerCase();
  const newSelection = { ...selectedValues };
  for (const field of fields) {
    let bestMatch = null;
    for (const val of field.values) if (normalized.includes(val.toLowerCase())) { bestMatch = val; break; }
    if (bestMatch) newSelection[field.id] = bestMatch;
    else if (!newSelection[field.id] && field.values.length) newSelection[field.id] = field.values[0];
  }
  return newSelection;
}
function generateStandardNameFromSelection(selection) {
  let parts = [];
  for (const field of fields) {
    const sel = selection[field.id];
    if (sel && isFieldVisibleBasedOnSelection(field.id, selection)) parts.push(sel);
  }
  const separator = getActiveSeparatorBasedOnSelection(selection);
  let result = parts.join(separator);
  const obs = document.getElementById('input-obs')?.value.trim() || "";
  if (obs) result += ` (${obs})`;
  return result || "(vazio)";
}
function isFieldVisibleBasedOnSelection(fieldId, selection) {
  let visible = true;
  for (const rule of rules)
    if (isConditionMet(rule.condition, selection))
      for (const action of rule.actions) {
        if (action.type === 'hide_field' && action.targetFieldId === fieldId) visible = false;
        if (action.type === 'show_field' && action.targetFieldId === fieldId) visible = true;
      }
  return visible;
}
function getActiveSeparatorBasedOnSelection(selection) {
  let separator = ' - ';
  for (const rule of rules)
    if (isConditionMet(rule.condition, selection))
      for (const action of rule.actions)
        if (action.type === 'set_separator') separator = action.separator;
  return separator;
}

// ==================== SKU ====================
function removerAcentos(str) { return str.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function generateSingleSKUFromSelection(selection) {
  let baseParts = [];
  for (let fieldId of skuConfig.fieldOrder) {
    const val = selection[fieldId];
    if (val) {
      let cleaned = removerAcentos(val).replace(/[^\w]/g, '');
      let code = cleaned.substring(0, 4).toUpperCase();
      baseParts.push(code);
    }
  }
  let sku = baseParts.join(skuConfig.partSeparator);
  if (!sku) return '';
  let finalSeparator = skuConfig.partSeparator;
  let prefix = '', suffix = '';
  for (let rule of skuConditionalRules) {
    if (isConditionMet(rule.condition, selection)) {
      if (rule.action.type === 'set_separator') finalSeparator = rule.action.value;
      else if (rule.action.type === 'set_prefix') prefix = rule.action.value + prefix;
      else if (rule.action.type === 'set_suffix') suffix = suffix + rule.action.value;
    }
  }
  sku = prefix + baseParts.join(finalSeparator) + suffix;
  if (skuConfig.addSuffix) {
    const min = Math.pow(10, skuConfig.suffixLength - 1);
    const max = Math.pow(10, skuConfig.suffixLength) - 1;
    const num = Math.floor(Math.random() * (max - min + 1)) + min;
    sku += finalSeparator + num;
  }
  if (skuConfig.uppercase) sku = sku.toUpperCase();
  return sku;
}
function generateSKUFromRawName(rawName) {
  const suggested = suggestValuesFromRawName(rawName);
  return generateSingleSKUFromSelection(suggested);
}
function generateSKU() {
  const nome = document.getElementById('sku-product-name').value.trim();
  if (!nome) { showToast("Digite um nome", true); return; }
  const sku = generateSKUFromRawName(nome);
  document.getElementById('sku-result-text').innerHTML = sku || "(vazio)";
  if (sku) addToHistory(sku, 'sku');
  showToast("SKU gerado");
}
function copySKUResult() {
  const text = document.getElementById('sku-result-text').innerText;
  if (!text || text === "Aguardando entrada...") return;
  navigator.clipboard?.writeText(text);
  showToast("Copiado!");
}
async function processSKUBatch() {
  const fileInput = document.getElementById('skubatch-import-file');
  if (!fileInput.files.length) { showToast("Selecione um arquivo", true); return; }
  const file = fileInput.files[0];
  const separator = document.getElementById('skubatch-csv-separator').value;
  const nameColumnIdx = parseInt(document.getElementById('skubatch-name-column').value) - 1;
  let rawNames = [];
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    if (ext === 'csv' || ext === 'txt') {
      const text = await file.text();
      const parsed = Papa.parse(text, { delimiter: separator === '\\t' ? '\t' : separator, header: false, skipEmptyLines: true });
      rawNames = parsed.data.map(row => row[nameColumnIdx]).filter(v => v && v.trim());
    } else if (ext === 'xlsx') {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      rawNames = rows.map(row => row[nameColumnIdx]).filter(v => v && v.trim());
    } else if (ext === 'json') {
      const text = await file.text();
      const json = JSON.parse(text);
      if (Array.isArray(json)) rawNames = json.map(item => typeof item === 'string' ? item : item[Object.keys(item)[0]]).filter(v => v);
      else if (json.data && Array.isArray(json.data)) rawNames = json.data.map(item => typeof item === 'string' ? item : item[Object.keys(item)[0]]);
      else showToast("JSON inválido", true);
    } else { showToast("Formato não suportado", true); return; }
  } catch (e) { showToast("Erro ao ler arquivo", true); return; }
  if (!rawNames.length) { showToast("Nenhum nome", true); return; }
  startSKUBatchProcessing(rawNames);
}
function startSKUBatchProcessing(rawNames) {
  skuBatchResults = [];
  skuBatchProcessingCancel = false;
  const progressArea = document.getElementById('skubatch-progress-area');
  progressArea.classList.remove('hidden');
  let processed = 0;
  const total = rawNames.length;
  const update = () => {
    const percent = Math.floor((processed / total) * 100);
    document.getElementById('skubatch-progress-bar').style.width = `${percent}%`;
    document.getElementById('skubatch-progress-percent').textContent = `${percent}%`;
    document.getElementById('skubatch-progress-text').textContent = `Processando ${processed} de ${total}...`;
    if (processed >= total) {
      progressArea.classList.add('hidden');
      displaySKUBatchResults();
      showToast(`${total} SKUs gerados`);
    }
  };
  const processChunk = () => {
    if (skuBatchProcessingCancel) { progressArea.classList.add('hidden'); return; }
    const limit = Math.min(processed + CHUNK_SIZE, total);
    for (let i = processed; i < limit; i++) {
      const sku = generateSKUFromRawName(rawNames[i]);
      skuBatchResults.push({ nome: rawNames[i], sku });
      addToHistory(sku, 'sku');
    }
    processed = limit;
    update();
    if (processed < total) setTimeout(processChunk, 10);
    else { addLog('sku_batch', `${total} SKUs gerados`); displaySKUBatchResults(); }
  };
  processChunk();
}
function displaySKUBatchResults() {
  const container = document.getElementById('skubatch-preview-container');
  if (!container) return;
  if (!skuBatchResults.length) {
    container.innerHTML = '<p class="text-gray-400 text-sm">Nenhum arquivo processado.</p>';
    document.getElementById('copy-all-skubatch-btn')?.classList.add('hidden');
    return;
  }
  let html = '<div class="space-y-3">';
  skuBatchResults.forEach((item, idx) => {
    html += `<div class="result-card flex justify-between items-center"><div><div class="text-xs text-gray-500">${escapeHtml(item.nome)}</div><div class="font-medium">${escapeHtml(item.sku)}</div></div><button onclick="copySpecificSKUResult(${idx})" class="text-blue-500 p-2">📋</button></div>`;
  });
  container.innerHTML = html;
  document.getElementById('copy-all-skubatch-btn')?.classList.remove('hidden');
}
function copySpecificSKUResult(idx) {
  if (skuBatchResults[idx]) { navigator.clipboard?.writeText(skuBatchResults[idx].sku); showToast("Copiado!"); }
}
function copyAllSKUBatchResults() {
  if (!skuBatchResults.length) return;
  const all = skuBatchResults.map(i => i.sku).join("\n");
  navigator.clipboard?.writeText(all);
  showToast(`${skuBatchResults.length} SKUs copiados`);
}

// ==================== NAVEGAÇÃO E UI ====================
function switchTab(tabId) {
  document.querySelectorAll('.view-section').forEach(s => s.classList.remove('active'));
  document.getElementById(`view-${tabId}`).classList.add('active');
  document.querySelectorAll('#tab-generator, #tab-settings').forEach(btn => btn.className = "flex-1 flex flex-col items-center justify-center text-gray-400");
  document.getElementById(`tab-${tabId}`).classList.replace('text-gray-400', 'text-blue-500');
  document.getElementById('nav-title').innerHTML = tabId === 'generator' ? 'Gerador' : 'Ajustes';
  if (tabId === 'generator') generatorGoBack();
  if (tabId === 'settings') settingsGoBack();
}
function generatorGoBack() {
  document.getElementById('generator-main').classList.remove('hidden');
  document.getElementById('generator-manual').classList.add('hidden');
  document.getElementById('generator-batch').classList.add('hidden');
  document.getElementById('generator-sku').classList.add('hidden');
  document.getElementById('generator-skubatch').classList.add('hidden');
  document.getElementById('back-generator-btn').classList.add('hidden');
  document.getElementById('nav-title').innerHTML = 'Gerador';
}
function settingsGoBack() {
  document.getElementById('settings-main').classList.remove('hidden');
  document.getElementById('settings-fields').classList.add('hidden');
  document.getElementById('settings-rules').classList.add('hidden');
  document.getElementById('settings-skurules').classList.add('hidden');
  document.getElementById('settings-history').classList.add('hidden');
  document.getElementById('settings-importexport').classList.add('hidden');
  document.getElementById('settings-backup').classList.add('hidden');
  document.getElementById('settings-logs').classList.add('hidden');
  document.getElementById('back-settings-btn').classList.add('hidden');
  document.getElementById('nav-title').innerHTML = 'Ajustes';
}
function showGeneratorSubview(subviewId) {
  document.getElementById('generator-main').classList.add('hidden');
  document.getElementById(`generator-${subviewId}`).classList.remove('hidden');
  document.getElementById('back-generator-btn').classList.remove('hidden');
  const titles = { manual: 'Padronizar Manual', batch: 'Importar Lista', sku: 'Gerar SKU', skubatch: 'Gerar SKU em Lote' };
  document.getElementById('nav-title').innerHTML = titles[subviewId];
  if (subviewId === 'manual') { renderGeneratorFields(); updatePreviewText(); }
  if (subviewId === 'batch') displayBatchResults();
  if (subviewId === 'skubatch') displaySKUBatchResults();
}
function showSettingsSubview(subviewId) {
  document.getElementById('settings-main').classList.add('hidden');
  document.getElementById(`settings-${subviewId}`).classList.remove('hidden');
  document.getElementById('back-settings-btn').classList.remove('hidden');
  const titles = { fields: 'Gerenciar Campos', rules: 'Regras (E/OU)', skurules: 'Regras do SKU', history: 'Histórico', importexport: 'Importar/Exportar Campos', backup: 'Backup', logs: 'Logs' };
  document.getElementById('nav-title').innerHTML = titles[subviewId];
  if (subviewId === 'fields') renderSettingsList();
  if (subviewId === 'rules') renderAutomationsList();
  if (subviewId === 'skurules') { renderSKURulesSettings(); renderSKUConditionalRulesList(); }
  if (subviewId === 'history') renderHistoryList();
  if (subviewId === 'logs') renderLogs();
}
// Placeholders para funções de configuração (podem ser expandidas)
function renderSettingsList() { const c = document.getElementById('settings-container'); if (c) c.innerHTML = '<div class="text-center py-8 text-gray-400">Gerencie campos aqui (UI completa disponível)</div>'; }
function renderAutomationsList() { const c = document.getElementById('automations-list'); if (c) c.innerHTML = '<div class="text-center text-gray-400 py-4">Regras configuráveis</div>'; }
function renderSKURulesSettings() {}
function renderSKUConditionalRulesList() {}
function renderHistoryList() { const c = document.getElementById('history-list'); if (c) c.innerHTML = '<div class="text-center text-gray-400">Histórico vazio</div>'; }
function renderLogs() { const c = document.getElementById('logs-container'); if (c) c.innerHTML = '<div class="text-center text-gray-400">Sem logs</div>'; }
function addNewField() { showToast("Função disponível na versão completa", true); }
function exportRules() { showToast("Função disponível na versão completa", true); }
function importRules() { showToast("Função disponível na versão completa", true); }
function showAdvancedRuleForm() { showToast("Função disponível na versão completa", true); }
function saveAdvancedRule() { showToast("Função disponível na versão completa", true); }
function closeRuleModal() { document.getElementById('rule-modal').classList.add('hidden'); }
function showSKUConditionalRuleForm() { showToast("Função disponível na versão completa", true); }
function saveSKUConditionalRule() { showToast("Função disponível na versão completa", true); }
function closeSKUCondModal() { document.getElementById('sku-cond-modal').classList.add('hidden'); }
function exportFieldsOnly() { showToast("Função disponível na versão completa", true); }
function importFieldsOnly() { showToast("Função disponível na versão completa", true); }
function exportConfig() { showToast("Função disponível na versão completa", true); }
function importConfig() { showToast("Função disponível na versão completa", true); }
function confirmResetToDefault() { if (confirm("Resetar configuração?")) location.reload(); }
function clearHistory() { generationHistory = []; localStorage.setItem('generation_history', '[]'); renderHistoryList(); showToast("Histórico limpo"); }
function clearLogs() { systemLogs = []; localStorage.setItem('product_padronizer_logs', '[]'); renderLogs(); showToast("Logs limpos"); }
function exportLogs() { if (!systemLogs.length) { showToast("Sem logs", true); return; } const blob = new Blob([JSON.stringify(systemLogs, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `logs_${Date.now()}.json`; a.click(); }
function addActionRow() { /* placeholder */ }

// ==================== INICIALIZAÇÃO E SERVICE WORKER ====================
function init() {
  loadLogsFromLocalStorage();
  loadFromLocalStorage();
  loadHistoryFromLocalStorage();
  initDefaultData();
  refreshAll();
  // Registro do Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW registrado', reg))
        .catch(err => console.log('Falha no SW', err));
    });
  }
  // PWA Install prompt
  let deferredPrompt;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const banner = document.getElementById('pwa-banner');
    if (banner) banner.classList.remove('hidden');
  });
  const installBtn = document.getElementById('install-pwa-btn');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(() => {
          deferredPrompt = null;
          const banner = document.getElementById('pwa-banner');
          if (banner) banner.classList.add('hidden');
        });
      }
    });
  }
}
init();
