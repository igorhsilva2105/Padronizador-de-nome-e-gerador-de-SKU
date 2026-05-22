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

// ==================== AUXILIARES ====================
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
function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
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
function cleanInvalidRules() {
  const validFieldIds = new Set(fields.map(f => f.id));
  const validFieldValues = new Map();
  fields.forEach(f => validFieldValues.set(f.id, new Set(f.values)));
  rules = rules.filter(rule => {
    let ok = true;
    if (rule.condition.type === 'simple') {
      const s = rule.condition.simple;
      if (!validFieldIds.has(s.sourceFieldId) || !validFieldValues.get(s.sourceFieldId)?.has(s.sourceValue)) ok = false;
    } else {
      const c = rule.condition.compound;
      if (!validFieldIds.has(c.sourceFieldId1) || !validFieldValues.get(c.sourceFieldId1)?.has(c.sourceValue1) ||
          !validFieldIds.has(c.sourceFieldId2) || !validFieldValues.get(c.sourceFieldId2)?.has(c.sourceValue2)) ok = false;
    }
    if (!ok) return false;
    rule.actions = rule.actions.filter(act => {
      if (act.type === 'set_separator') return true;
      if (!validFieldIds.has(act.targetFieldId)) return false;
      if ((act.type === 'hide_value' || act.type === 'show_value') && act.targetValue && !validFieldValues.get(act.targetFieldId)?.has(act.targetValue)) return false;
      return true;
    });
    return rule.actions.length > 0;
  });
  saveToLocalStorage();
}
function refreshAll() {
  renderGeneratorFields();
  if (document.getElementById('settings-fields') && !document.getElementById('settings-fields').classList.contains('hidden')) renderSettingsList();
  if (document.getElementById('settings-rules') && !document.getElementById('settings-rules').classList.contains('hidden')) renderAutomationsList();
  if (document.getElementById('settings-skurules') && !document.getElementById('settings-skurules').classList.contains('hidden')) {
    renderSKURulesSettings();
    renderSKUConditionalRulesList();
  }
  if (document.getElementById('settings-history') && !document.getElementById('settings-history').classList.contains('hidden')) renderHistoryList();
  if (document.getElementById('settings-logs') && !document.getElementById('settings-logs').classList.contains('hidden')) renderLogs();
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
function closeSuggestionsModal() { document.getElementById('suggestions-modal')?.classList.add('hidden'); pendingSuggestions = []; }

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
function reprocessBatchImport() { if (pendingBatchImportData) startBatchProcessing(pendingBatchImportData.rawNames); }
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
function copySpecificResult(idx) { if (batchResults[idx]) { navigator.clipboard?.writeText(batchResults[idx]); showToast("Copiado!"); } }
function copyAllBatchResults() { if (!batchResults.length) return; const all = batchResults.join("\n"); navigator.clipboard?.writeText(all); showToast(`${batchResults.length} resultados copiados`); }
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
function copySpecificSKUResult(idx) { if (skuBatchResults[idx]) { navigator.clipboard?.writeText(skuBatchResults[idx].sku); showToast("Copiado!"); } }
function copyAllSKUBatchResults() { if (!skuBatchResults.length) return; const all = skuBatchResults.map(i => i.sku).join("\n"); navigator.clipboard?.writeText(all); showToast(`${skuBatchResults.length} SKUs copiados`); }

// ==================== GERENCIAMENTO DE CAMPOS ====================
function renderSettingsList() {
  const container = document.getElementById('settings-container');
  if (!container) return;
  container.innerHTML = '';
  fields.forEach((field, idx) => {
    const card = document.createElement('div');
    card.className = "mb-6 mx-4 bg-white rounded-xl shadow-sm overflow-hidden";
    const header = document.createElement('div');
    header.className = "flex items-center justify-between p-4 bg-gray-50 border-b border-gray-100";
    const leftDiv = document.createElement('div');
    leftDiv.className = "flex items-center gap-2";
    const upFieldBtn = mkMoveBtn('↑', () => moveFieldUp(idx));
    const downFieldBtn = mkMoveBtn('↓', () => moveFieldDown(idx));
    leftDiv.appendChild(upFieldBtn);
    leftDiv.appendChild(downFieldBtn);
    const titleContainer = document.createElement('div');
    titleContainer.className = "flex items-center gap-2 cursor-pointer";
    const titleSpan = document.createElement('span');
    titleSpan.textContent = field.label;
    titleSpan.className = "font-semibold text-gray-800 text-base field-title-edit px-2 py-1 rounded-md";
    const editIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    editIcon.setAttribute("class", "w-4 h-4 text-gray-400");
    editIcon.setAttribute("fill", "none");
    editIcon.setAttribute("stroke", "currentColor");
    editIcon.setAttribute("viewBox", "0 0 24 24");
    editIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path>`;
    titleContainer.appendChild(titleSpan);
    titleContainer.appendChild(editIcon);
    leftDiv.appendChild(titleContainer);
    const removeBtn = document.createElement('button');
    removeBtn.innerHTML = `<svg class="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>`;
    removeBtn.className = "p-2 text-red-500 hover:bg-red-50 rounded-full";
    removeBtn.onclick = () => removeField(field.id);
    header.appendChild(leftDiv);
    header.appendChild(removeBtn);
    titleContainer.addEventListener("click", (e) => { e.stopPropagation(); enableTitleEdit(field, titleContainer); });
    card.appendChild(header);
    const valuesDiv = document.createElement('div');
    valuesDiv.className = "divide-y divide-gray-100";
    field.values.forEach((val, vIdx) => {
      const row = document.createElement('div');
      row.className = "ios-list-item !pl-4 !pr-2";
      const actions = document.createElement('div');
      actions.className = "value-actions flex gap-1";
      const upValBtn = mkMoveBtn('↑', () => moveValueUp(field.id, vIdx));
      const downValBtn = mkMoveBtn('↓', () => moveValueDown(field.id, vIdx));
      const removeValBtn = document.createElement('button');
      removeValBtn.innerHTML = `<svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;
      removeValBtn.className = "p-1 hover:bg-red-50 rounded-full";
      removeValBtn.onclick = () => removeOptionFromField(field.id, vIdx);
      actions.appendChild(upValBtn);
      actions.appendChild(downValBtn);
      actions.appendChild(removeValBtn);
      const span = document.createElement('span');
      span.textContent = val;
      span.className = "text-gray-800 text-[16px] flex-1";
      const wrapper = document.createElement('div');
      wrapper.className = "flex items-center justify-between w-full";
      wrapper.appendChild(span);
      wrapper.appendChild(actions);
      row.appendChild(wrapper);
      valuesDiv.appendChild(row);
    });
    const addRow = document.createElement('div');
    addRow.className = "ios-list-item bg-gray-50 !pl-4";
    addRow.innerHTML = `<div class="flex items-center w-full gap-2"><button class="add-value-btn p-1 text-green-500"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clip-rule="evenodd"></path></svg></button><input type="text" id="add-value-input-${field.id}" placeholder="Adicionar novo valor..." class="w-full bg-transparent outline-none text-[17px] py-1" onkeypress="handleEnterValue(event, '${field.id}')"></div>`;
    addRow.querySelector('.add-value-btn').onclick = () => addOptionToField(field.id);
    valuesDiv.appendChild(addRow);
    card.appendChild(valuesDiv);
    container.appendChild(card);
  });
  if (!fields.length) container.innerHTML = '<div class="text-center py-12 text-gray-400">Nenhum campo cadastrado. Clique em "+ Novo Campo".</div>';
}
function mkMoveBtn(icon, onclick) {
  const btn = document.createElement('button');
  btn.innerHTML = `<svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${icon === '↑' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'}"></path></svg>`;
  btn.className = "move-btn p-1 hover:bg-gray-200 rounded-full transition-colors";
  btn.onclick = (e) => { e.stopPropagation(); onclick(); };
  return btn;
}
function enableTitleEdit(field, container) {
  const input = document.createElement('input');
  input.value = field.label;
  input.className = "edit-input font-semibold text-gray-800 text-base";
  input.style.width = `${Math.max(field.label.length+2, 8)}ch`;
  container.innerHTML = '';
  container.appendChild(input);
  input.focus();
  input.select();
  const finish = () => {
    const newLabel = input.value.trim();
    if (newLabel && newLabel !== field.label) {
      field.label = newLabel;
      refreshAll();
      addLog('field_rename', `Campo "${field.label}"`);
      showToast("Renomeado");
    } else refreshAll();
  };
  input.addEventListener("blur", finish);
  input.addEventListener("keypress", (e) => { if (e.key === "Enter") finish(); });
}
function moveFieldUp(index) {
  if (index <= 0) return;
  [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
  if (skuConfig && skuConfig.fieldOrder) {
    const id1 = fields[index - 1].id, id2 = fields[index].id;
    const pos1 = skuConfig.fieldOrder.indexOf(id1), pos2 = skuConfig.fieldOrder.indexOf(id2);
    if (pos1 !== -1 && pos2 !== -1) [skuConfig.fieldOrder[pos1], skuConfig.fieldOrder[pos2]] = [skuConfig.fieldOrder[pos2], skuConfig.fieldOrder[pos1]];
  }
  refreshAll();
  renderSettingsList();
  addLog('field_move', `Campo "${fields[index - 1].label}" movido para cima`);
  showToast("Campo movido para cima");
}
function moveFieldDown(index) {
  if (index >= fields.length - 1) return;
  [fields[index + 1], fields[index]] = [fields[index], fields[index + 1]];
  if (skuConfig && skuConfig.fieldOrder) {
    const id1 = fields[index + 1].id, id2 = fields[index].id;
    const pos1 = skuConfig.fieldOrder.indexOf(id1), pos2 = skuConfig.fieldOrder.indexOf(id2);
    if (pos1 !== -1 && pos2 !== -1) [skuConfig.fieldOrder[pos1], skuConfig.fieldOrder[pos2]] = [skuConfig.fieldOrder[pos2], skuConfig.fieldOrder[pos1]];
  }
  refreshAll();
  renderSettingsList();
  addLog('field_move', `Campo "${fields[index + 1].label}" movido para baixo`);
  showToast("Campo movido para baixo");
}
function moveValueUp(fieldId, valueIndex) {
  const field = fields.find(f => f.id === fieldId);
  if (!field || valueIndex <= 0) return;
  [field.values[valueIndex - 1], field.values[valueIndex]] = [field.values[valueIndex], field.values[valueIndex - 1]];
  refreshAll();
  renderSettingsList();
  addLog('value_move', `Valor "${field.values[valueIndex - 1]}" movido para cima em ${field.label}`);
  showToast("Valor movido para cima");
}
function moveValueDown(fieldId, valueIndex) {
  const field = fields.find(f => f.id === fieldId);
  if (!field || valueIndex >= field.values.length - 1) return;
  [field.values[valueIndex + 1], field.values[valueIndex]] = [field.values[valueIndex], field.values[valueIndex + 1]];
  refreshAll();
  renderSettingsList();
  addLog('value_move', `Valor "${field.values[valueIndex + 1]}" movido para baixo em ${field.label}`);
  showToast("Valor movido para baixo");
}
function addNewField() {
  const newId = `field_${nextFieldId++}`;
  const newLabel = `Novo Campo ${fields.length + 1}`;
  fields.push({ id: newId, label: newLabel, values: ["Exemplo"] });
  selectedValues[newId] = "Exemplo";
  if (skuConfig && skuConfig.fieldOrder && !skuConfig.fieldOrder.includes(newId)) skuConfig.fieldOrder.push(newId);
  refreshAll();
  renderSettingsList();
  addLog('field_add', `Campo "${newLabel}" criado`);
  showToast("Campo adicionado");
}
function removeField(fieldId) {
  if (!confirm("Remover campo?")) return;
  const idx = fields.findIndex(f => f.id === fieldId);
  const label = fields[idx].label;
  delete selectedValues[fieldId];
  fields.splice(idx, 1);
  rules = rules.filter(r => !((r.condition.type === 'simple' && r.condition.simple.sourceFieldId === fieldId) || (r.condition.type === 'compound' && (r.condition.compound.sourceFieldId1 === fieldId || r.condition.compound.sourceFieldId2 === fieldId)) || r.actions.some(a => a.targetFieldId === fieldId)));
  skuConfig.fieldOrder = skuConfig.fieldOrder.filter(id => id !== fieldId);
  skuConditionalRules = skuConditionalRules.filter(r => r.condition.fieldId !== fieldId);
  cleanInvalidRules();
  refreshAll();
  renderSettingsList();
  addLog('field_remove', label);
  showToast("Campo removido");
}
function addOptionToField(fieldId) {
  const input = document.getElementById(`add-value-input-${fieldId}`);
  if (!input) return;
  const val = input.value.trim();
  if (!val) { showToast("Digite um valor", true); return; }
  const field = fields.find(f => f.id === fieldId);
  if (field && !field.values.includes(val)) {
    field.values.push(val);
    if (!selectedValues[fieldId]) selectedValues[fieldId] = val;
    refreshAll();
    renderSettingsList();
    addLog('value_add', `${val} em ${field.label}`);
    showToast("Valor adicionado");
    input.value = '';
  } else showToast("Valor já existe", true);
}
function removeOptionFromField(fieldId, valIdx) {
  const field = fields.find(f => f.id === fieldId);
  if (!field) return;
  const removed = field.values[valIdx];
  if (selectedValues[fieldId] === removed) selectedValues[fieldId] = field.values.length > 1 ? field.values.find(v => v !== removed) : null;
  field.values.splice(valIdx, 1);
  cleanInvalidRules();
  refreshAll();
  renderSettingsList();
  addLog('value_remove', removed);
  showToast("Removido");
}
function handleEnterValue(e, fieldId) { if (e.key === 'Enter') { e.preventDefault(); addOptionToField(fieldId); } }

// ==================== REGRAS E/OU ====================
function renderAutomationsList() {
  const container = document.getElementById('automations-list');
  if (!container) return;
  if (!rules.length) { container.innerHTML = '<div class="text-center text-gray-400 py-8">Nenhuma regra criada.</div>'; return; }
  let html = '';
  rules.forEach((rule, idx) => {
    let conditionDesc = '';
    if (rule.condition.type === 'simple') {
      const s = rule.condition.simple;
      const srcField = fields.find(f => f.id === s.sourceFieldId);
      const opSymbol = { eq: '=', neq: '≠', contains: '⊃' }[s.operator || 'eq'];
      conditionDesc = `Se "${srcField?.label}" ${opSymbol} "${s.sourceValue}"`;
    } else {
      const c = rule.condition.compound;
      const f1 = fields.find(f => f.id === c.sourceFieldId1);
      const f2 = fields.find(f => f.id === c.sourceFieldId2);
      const op1 = { eq: '=', neq: '≠', contains: '⊃' }[c.operator1 || 'eq'];
      const op2 = { eq: '=', neq: '≠', contains: '⊃' }[c.operator2 || 'eq'];
      const logic = c.logic === 'AND' ? 'E' : 'OU';
      conditionDesc = `Se (${f1?.label} ${op1} "${c.sourceValue1}" ${logic} ${f2?.label} ${op2} "${c.sourceValue2}")`;
    }
    let actionsHtml = '<div class="mt-2 text-sm"><ul class="list-disc list-inside text-xs">';
    rule.actions.forEach(act => {
      if (act.type === 'hide_field') { const targetField = fields.find(f => f.id === act.targetFieldId); actionsHtml += `<li>Ocultar campo "${targetField?.label}"</li>`; }
      else if (act.type === 'show_field') { const targetField = fields.find(f => f.id === act.targetFieldId); actionsHtml += `<li>Mostrar campo "${targetField?.label}"</li>`; }
      else if (act.type === 'hide_value') { const targetField = fields.find(f => f.id === act.targetFieldId); actionsHtml += `<li>Ocultar valor "${act.targetValue}" de "${targetField?.label}"</li>`; }
      else if (act.type === 'show_value') { const targetField = fields.find(f => f.id === act.targetFieldId); actionsHtml += `<li>Mostrar valor "${act.targetValue}" de "${targetField?.label}"</li>`; }
      else if (act.type === 'set_separator') { actionsHtml += `<li>Separador: "${act.separator}"</li>`; }
    });
    actionsHtml += '</ul></div>';
    html += `<div class="bg-white rounded-xl shadow-sm p-3 rule-card flex justify-between items-center"><div><div class="font-medium">${conditionDesc}</div>${actionsHtml}</div><div class="flex gap-1"><button onclick="moveRuleUp(${idx})" class="text-blue-500 p-1">↑</button><button onclick="moveRuleDown(${idx})" class="text-blue-500 p-1">↓</button><button onclick="removeRule('${rule.id}')" class="text-red-500 p-1">🗑️</button></div></div>`;
  });
  container.innerHTML = html;
}
function moveRuleUp(idx) { if (idx <= 0) return; [rules[idx-1], rules[idx]] = [rules[idx], rules[idx-1]]; renderAutomationsList(); saveToLocalStorage(); addLog('rule_reorder', 'Regra movida para cima'); showToast("Ordem alterada"); }
function moveRuleDown(idx) { if (idx >= rules.length-1) return; [rules[idx+1], rules[idx]] = [rules[idx], rules[idx+1]]; renderAutomationsList(); saveToLocalStorage(); addLog('rule_reorder', 'Regra movida para baixo'); showToast("Ordem alterada"); }
let actionRows = [];
function showAdvancedRuleForm() {
  actionRows = []; document.getElementById('actions-container').innerHTML = ''; addActionRow();
  const simpleField = document.getElementById('rule-source-field-simple');
  const simpleVal = document.getElementById('rule-source-value-simple');
  const field1 = document.getElementById('rule-source-field1');
  const val1 = document.getElementById('rule-source-value1');
  const field2 = document.getElementById('rule-source-field2');
  const val2 = document.getElementById('rule-source-value2');
  [simpleField, field1, field2].forEach(sel => { sel.innerHTML = ''; fields.forEach(f => sel.appendChild(new Option(f.label, f.id))); });
  const updateSimple = () => { const f = fields.find(f => f.id === simpleField.value); simpleVal.innerHTML = ''; if (f) f.values.forEach(v => simpleVal.appendChild(new Option(v, v))); };
  simpleField.onchange = updateSimple; updateSimple();
  const update = (fs, vs) => { const f = fields.find(f => f.id === fs.value); vs.innerHTML = ''; if (f) f.values.forEach(v => vs.appendChild(new Option(v, v))); };
  field1.onchange = () => update(field1, val1); field2.onchange = () => update(field2, val2);
  update(field1, val1); update(field2, val2);
  document.getElementById('rule-modal').classList.remove('hidden');
}
function addActionRow() {
  const container = document.getElementById('actions-container');
  const rowDiv = document.createElement('div');
  rowDiv.className = "action-row bg-gray-50 p-3 rounded-lg border mb-2";
  rowDiv.innerHTML = `<select class="action-type mb-2 w-full border rounded p-1"><option value="hide_field">Ocultar campo</option><option value="show_field">Mostrar campo</option><option value="hide_value">Ocultar valor</option><option value="show_value">Mostrar valor</option><option value="set_separator">Definir separador</option></select><select class="action-field mb-2 w-full border rounded p-1"></select><select class="action-value w-full border rounded p-1" style="display:none"></select><input type="text" class="action-separator w-full border rounded p-1" placeholder="Separador" style="display:none"><button type="button" class="text-red-500 text-xs mt-1" onclick="this.closest('.action-row').remove()">Remover ação</button>`;
  const typeSel = rowDiv.querySelector('.action-type');
  const fieldSel = rowDiv.querySelector('.action-field');
  const valueSel = rowDiv.querySelector('.action-value');
  const sepInp = rowDiv.querySelector('.action-separator');
  fields.forEach(f => fieldSel.appendChild(new Option(f.label, f.id)));
  const update = () => {
    const isSep = typeSel.value === 'set_separator';
    fieldSel.style.display = isSep ? 'none' : 'block';
    valueSel.style.display = (!isSep && (typeSel.value === 'hide_value' || typeSel.value === 'show_value')) ? 'block' : 'none';
    sepInp.style.display = isSep ? 'block' : 'none';
    if (!isSep) {
      const fid = fieldSel.value;
      const f = fields.find(f => f.id === fid);
      valueSel.innerHTML = '<option value="">-- valor --</option>';
      if (f) f.values.forEach(v => valueSel.appendChild(new Option(v, v)));
    }
  };
  typeSel.onchange = update; fieldSel.onchange = update; update();
  container.appendChild(rowDiv);
  actionRows.push(rowDiv);
}
function saveAdvancedRule() {
  const condType = document.getElementById('condition-type').value;
  let condition;
  if (condType === 'simple') {
    const sourceFieldId = document.getElementById('rule-source-field-simple').value;
    const operator = document.getElementById('simple-operator').value;
    const sourceValue = document.getElementById('rule-source-value-simple').value;
    if (!sourceFieldId || !sourceValue) { showToast("Preencha condição", true); return; }
    condition = { type: 'simple', simple: { sourceFieldId, operator, sourceValue } };
  } else {
    const f1 = document.getElementById('rule-source-field1').value;
    const op1 = document.getElementById('operator1').value;
    const v1 = document.getElementById('rule-source-value1').value;
    const logic = document.getElementById('compound-operator').value;
    const f2 = document.getElementById('rule-source-field2').value;
    const op2 = document.getElementById('operator2').value;
    const v2 = document.getElementById('rule-source-value2').value;
    if (!f1 || !v1 || !f2 || !v2) { showToast("Preencha ambos os lados", true); return; }
    condition = { type: 'compound', compound: { sourceFieldId1: f1, operator1: op1, sourceValue1: v1, logic, sourceFieldId2: f2, operator2: op2, sourceValue2: v2 } };
  }
  const actions = [];
  document.querySelectorAll('.action-row').forEach(row => {
    const type = row.querySelector('.action-type').value;
    if (type === 'set_separator') {
      const sep = row.querySelector('.action-separator').value.trim();
      if (!sep) { showToast("Separador obrigatório", true); return; }
      actions.push({ type, separator: sep });
    } else {
      const targetFieldId = row.querySelector('.action-field').value;
      if (!targetFieldId) return;
      if (type === 'hide_value' || type === 'show_value') {
        const targetValue = row.querySelector('.action-value').value;
        if (!targetValue) { showToast("Selecione um valor", true); return; }
        actions.push({ type, targetFieldId, targetValue });
      } else { actions.push({ type, targetFieldId }); }
    }
  });
  if (!actions.length) { showToast("Adicione ações", true); return; }
  const newRule = { id: `rule_${nextRuleId++}`, condition, actions };
  rules.push(newRule);
  cleanInvalidRules();
  refreshAll();
  renderAutomationsList();
  closeRuleModal();
  addLog('rule_add', `Regra ${condType}`);
  showToast("Regra salva");
}
function removeRule(ruleId) { rules = rules.filter(r => r.id !== ruleId); refreshAll(); renderAutomationsList(); addLog('rule_remove', 'Regra removida'); showToast("Regra removida"); }
function closeRuleModal() { document.getElementById('rule-modal').classList.add('hidden'); actionRows = []; }

// ==================== REGRAS DO SKU ====================
function renderSKURulesSettings() {
  const container = document.getElementById('sku-fields-order');
  if (!container) return;
  skuConfig.fieldOrder = skuConfig.fieldOrder.filter(id => fields.some(f => f.id === id));
  for (let field of fields) if (!skuConfig.fieldOrder.includes(field.id)) skuConfig.fieldOrder.push(field.id);
  let html = `<div class="border rounded-lg overflow-hidden">`;
  skuConfig.fieldOrder.forEach((fieldId, idx) => {
    const field = fields.find(f => f.id === fieldId);
    if (!field) return;
    html += `<div class="flex justify-between items-center p-2 border-b"><div class="flex items-center gap-2"><span class="cursor-move">☰</span><span>${escapeHtml(field.label)}</span></div><div class="flex gap-1"><button onclick="moveSKUFieldUp(${idx})" class="text-blue-500 px-2">↑</button><button onclick="moveSKUFieldDown(${idx})" class="text-blue-500 px-2">↓</button><label><input type="checkbox" class="sku-field-enable" data-id="${fieldId}" ${skuConfig.fieldOrder.includes(fieldId) ? 'checked' : ''}> Usar</label></div></div>`;
  });
  html += `</div><p class="text-xs text-gray-400 mt-2">Os campos marcados serão usados na ordem mostrada. Desmarque para excluir.</p>`;
  container.innerHTML = html;
  document.querySelectorAll('.sku-field-enable').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const fid = cb.dataset.id;
      if (cb.checked) { if (!skuConfig.fieldOrder.includes(fid)) skuConfig.fieldOrder.push(fid); }
      else { skuConfig.fieldOrder = skuConfig.fieldOrder.filter(id => id !== fid); }
      renderSKURulesSettings();
      saveToLocalStorage();
    });
  });
  document.getElementById('sku-part-separator').value = skuConfig.partSeparator;
  document.getElementById('sku-add-suffix').checked = skuConfig.addSuffix;
  document.getElementById('sku-suffix-length-config').value = skuConfig.suffixLength;
  document.getElementById('sku-uppercase-config').checked = skuConfig.uppercase;
  const suffixDiv = document.getElementById('sku-suffix-options');
  const toggleSuffix = () => { suffixDiv.style.display = document.getElementById('sku-add-suffix').checked ? 'block' : 'none'; };
  document.getElementById('sku-add-suffix').addEventListener('change', toggleSuffix);
  toggleSuffix();
}
function moveSKUFieldUp(idx) { if (idx <= 0) return; [skuConfig.fieldOrder[idx-1], skuConfig.fieldOrder[idx]] = [skuConfig.fieldOrder[idx], skuConfig.fieldOrder[idx-1]]; renderSKURulesSettings(); saveToLocalStorage(); addLog('sku_base_reorder', 'Ordem dos campos alterada'); showToast("Ordem atualizada"); }
function moveSKUFieldDown(idx) { if (idx >= skuConfig.fieldOrder.length-1) return; [skuConfig.fieldOrder[idx+1], skuConfig.fieldOrder[idx]] = [skuConfig.fieldOrder[idx], skuConfig.fieldOrder[idx+1]]; renderSKURulesSettings(); saveToLocalStorage(); addLog('sku_base_reorder', 'Ordem dos campos alterada'); showToast("Ordem atualizada"); }
function saveSKUBaseRules() {
  skuConfig.partSeparator = document.getElementById('sku-part-separator').value || '_';
  skuConfig.addSuffix = document.getElementById('sku-add-suffix').checked;
  skuConfig.suffixLength = parseInt(document.getElementById('sku-suffix-length-config').value) || 3;
  skuConfig.uppercase = document.getElementById('sku-uppercase-config').checked;
  saveToLocalStorage();
  addLog('sku_base_save', 'Configurações base do SKU salvas');
  showToast("Configurações base salvas");
}
function renderSKUConditionalRulesList() {
  const container = document.getElementById('sku-conditional-rules-list');
  if (!container) return;
  if (!skuConditionalRules.length) { container.innerHTML = '<div class="text-center text-gray-400 py-4 text-sm">Nenhuma regra condicional criada.</div>'; return; }
  let html = '';
  skuConditionalRules.forEach((rule, idx) => {
    const field = fields.find(f => f.id === rule.condition.fieldId);
    const opSymbol = { eq: '=', neq: '≠', contains: '⊃' }[rule.condition.operator];
    const actionType = { set_separator: 'Separador', set_prefix: 'Prefixo', set_suffix: 'Sufixo' }[rule.action.type];
    html += `<div class="bg-purple-50 border-l-4 border-purple-500 rounded-lg p-3 flex justify-between items-center">
                <div class="text-sm"><span class="font-medium">Se ${field?.label} ${opSymbol} "${rule.condition.value}"</span> → <span class="text-purple-700">${actionType}: "${rule.action.value}"</span></div>
                <div class="flex gap-1"><button onclick="moveSKUCondRuleUp(${idx})" class="text-blue-500 p-1">↑</button><button onclick="moveSKUCondRuleDown(${idx})" class="text-blue-500 p-1">↓</button><button onclick="removeSKUConditionalRule(${idx})" class="text-red-500 p-1">🗑️</button></div>
             </div>`;
  });
  container.innerHTML = html;
}
function moveSKUCondRuleUp(idx) { if (idx <= 0) return; [skuConditionalRules[idx-1], skuConditionalRules[idx]] = [skuConditionalRules[idx], skuConditionalRules[idx-1]]; renderSKUConditionalRulesList(); saveToLocalStorage(); addLog('sku_cond_move', 'Regra SKU movida'); showToast("Ordem alterada"); }
function moveSKUCondRuleDown(idx) { if (idx >= skuConditionalRules.length-1) return; [skuConditionalRules[idx+1], skuConditionalRules[idx]] = [skuConditionalRules[idx], skuConditionalRules[idx+1]]; renderSKUConditionalRulesList(); saveToLocalStorage(); addLog('sku_cond_move', 'Regra SKU movida'); showToast("Ordem alterada"); }
function showSKUConditionalRuleForm() {
  const fieldSel = document.getElementById('sku-cond-field');
  fieldSel.innerHTML = ''; fields.forEach(f => fieldSel.appendChild(new Option(f.label, f.id)));
  const valSel = document.getElementById('sku-cond-value');
  const updateValues = () => { const fid = fieldSel.value; const f = fields.find(f => f.id === fid); valSel.innerHTML = ''; if (f) f.values.forEach(v => valSel.appendChild(new Option(v, v))); };
  fieldSel.onchange = updateValues; updateValues();
  document.getElementById('sku-cond-action-value').value = '';
  document.getElementById('sku-cond-modal').classList.remove('hidden');
}
function saveSKUConditionalRule() {
  const fieldId = document.getElementById('sku-cond-field').value;
  const operator = document.getElementById('sku-cond-operator').value;
  const value = document.getElementById('sku-cond-value').value;
  const actionType = document.getElementById('sku-cond-action-type').value;
  const actionVal = document.getElementById('sku-cond-action-value').value.trim();
  if (!fieldId || !value || !actionVal) { showToast("Preencha todos os campos", true); return; }
  skuConditionalRules.push({ condition: { fieldId, operator, value }, action: { type: actionType, value: actionVal } });
  renderSKUConditionalRulesList();
  saveToLocalStorage();
  addLog('sku_cond_add', `Regra: ${actionType} = ${actionVal}`);
  showToast("Regra adicionada");
  closeSKUCondModal();
}
function removeSKUConditionalRule(idx) { skuConditionalRules.splice(idx,1); renderSKUConditionalRulesList(); saveToLocalStorage(); addLog('sku_cond_remove', 'Regra removida'); showToast("Regra removida"); }
function closeSKUCondModal() { document.getElementById('sku-cond-modal').classList.add('hidden'); }

// ==================== IMPORTAÇÃO/EXPORTAÇÃO ====================
function exportFieldsOnly() { if (!fields.length) { showToast("Nenhum campo", true); return; } const blob = new Blob([JSON.stringify(fields, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `campos_${Date.now()}.json`; a.click(); addLog('export_fields', 'Campos exportados'); showToast("Exportado"); }
function importFieldsOnly(input) { const file = input.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = e => { try { const imported = JSON.parse(e.target.result); if (!Array.isArray(imported)) throw new Error(); fields = imported; const newSel = {}; fields.forEach(f => { if (selectedValues[f.id] && f.values.includes(selectedValues[f.id])) newSel[f.id] = selectedValues[f.id]; else if (f.values.length) newSel[f.id] = f.values[0]; }); selectedValues = newSel; let maxId = 0; fields.forEach(f => { const num = parseInt(f.id.split('_')[1]); if (!isNaN(num) && num > maxId) maxId = num; }); nextFieldId = maxId + 1; skuConfig.fieldOrder = skuConfig.fieldOrder.filter(id => fields.some(f => f.id === id)); fields.forEach(f => { if (!skuConfig.fieldOrder.includes(f.id)) skuConfig.fieldOrder.push(f.id); }); cleanInvalidRules(); refreshAll(); renderSettingsList(); addLog('import_fields', `${imported.length} campos`); showToast("Importado"); } catch(err) { showToast("Arquivo inválido", true); } input.value = ''; }; reader.readAsText(file); }
function exportRules() { if (!rules.length) { showToast("Nenhuma regra", true); return; } const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `regras_${Date.now()}.json`; a.click(); addLog('export_rules', 'Regras exportadas'); showToast("Exportado"); }
function importRules(input) { const file = input.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = e => { try { const imported = JSON.parse(e.target.result); if (!Array.isArray(imported)) throw new Error(); rules = imported; let maxId = 0; rules.forEach(r => { const num = parseInt(r.id.split('_')[1]); if (!isNaN(num) && num > maxId) maxId = num; }); nextRuleId = maxId + 1; cleanInvalidRules(); refreshAll(); renderAutomationsList(); addLog('import_rules', `${imported.length} regras`); showToast("Importado"); } catch(err) { showToast("Arquivo inválido", true); } input.value = ''; }; reader.readAsText(file); }
function exportConfig() { const cfg = { fields, selectedValues, rules, nextFieldId, nextRuleId, skuConfig, skuConditionalRules }; const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `config_completa_${Date.now()}.json`; a.click(); addLog('config_export', 'Configuração exportada'); showToast("Exportado"); }
function importConfig(input) { const file = input.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = e => { try { const cfg = JSON.parse(e.target.result); fields = cfg.fields || []; selectedValues = cfg.selectedValues || {}; rules = cfg.rules || []; nextFieldId = cfg.nextFieldId || 1; nextRuleId = cfg.nextRuleId || 1; if (cfg.skuConfig) skuConfig = cfg.skuConfig; else skuConfig = { fieldOrder: fields.map(f => f.id), partSeparator: '_', addSuffix: true, suffixLength: 3, uppercase: true }; skuConditionalRules = cfg.skuConditionalRules || []; skuConfig.fieldOrder = skuConfig.fieldOrder.filter(id => fields.some(f => f.id === id)); fields.forEach(f => { if (!skuConfig.fieldOrder.includes(f.id)) skuConfig.fieldOrder.push(f.id); }); cleanInvalidRules(); refreshAll(); renderSettingsList(); renderAutomationsList(); renderSKURulesSettings(); renderSKUConditionalRulesList(); addLog('config_import', 'Configuração importada'); showToast("Importado"); } catch(err) { showToast("Arquivo inválido", true); } input.value = ''; }; reader.readAsText(file); }
function confirmResetToDefault() { if (confirm("Resetar configuração?")) { fields = []; selectedValues = {}; rules = []; skuConditionalRules = []; nextFieldId = 1; nextRuleId = 1; initDefaultData(); cleanInvalidRules(); refreshAll(); renderSettingsList(); renderAutomationsList(); renderSKURulesSettings(); renderSKUConditionalRulesList(); addLog('reset_default', 'Reset para padrão'); showToast("Configuração restaurada"); } }

// ==================== LOGS E HISTÓRICO ====================
function renderLogs() { const container = document.getElementById('logs-container'); if (!container) return; if (!systemLogs.length) { container.innerHTML = '<div class="text-center text-gray-400 py-8">Nenhum log</div>'; return; } let html = '<div class="divide-y">'; systemLogs.slice(0, 200).forEach(log => { const date = new Date(log.timestamp); html += `<div class="p-3 text-sm"><div class="font-medium">${log.action}</div><div class="text-xs text-gray-400">${date.toLocaleString('pt-BR')}</div><div class="text-xs text-gray-500 break-all">${escapeHtml(log.details)}</div></div>`; }); html += '</div>'; container.innerHTML = html; }
function exportLogs() { if (!systemLogs.length) { showToast("Nenhum log", true); return; } const blob = new Blob([JSON.stringify(systemLogs, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `logs_${Date.now()}.json`; a.click(); addLog('logs_export', 'Logs exportados'); showToast("Exportado"); }
function clearLogs() { if (confirm("Limpar logs?")) { systemLogs = []; localStorage.setItem('product_padronizer_logs', '[]'); renderLogs(); addLog('logs_clear', 'Logs limpos'); showToast("Logs limpos"); } }
function renderHistoryList() { const container = document.getElementById('history-list'); if (!container) return; if (!generationHistory.length) { container.innerHTML = '<div class="text-center text-gray-400 py-8">Nenhum item gerado.</div>'; return; } let html = '<div class="space-y-2">'; generationHistory.forEach(item => { const date = new Date(item.timestamp); const formatted = date.toLocaleString('pt-BR'); const icon = item.type === 'label' ? '🏷️' : '🔢'; html += `<div class="bg-gray-50 rounded-xl p-3 border"><div class="flex justify-between items-start"><div><div class="text-xs text-gray-400">${icon} ${item.type === 'label' ? 'Etiqueta' : 'SKU'} • ${formatted}</div><div class="text-sm font-medium break-all">${escapeHtml(item.content)}</div></div><div><button onclick="copyHistoryItem('${item.id}')" class="text-blue-500 p-1">📋</button><button onclick="reloadHistoryItem('${item.id}')" class="text-green-600 p-1">↺</button></div></div></div>`; }); html += '</div>'; container.innerHTML = html; }
function copyHistoryItem(id) { const item = generationHistory.find(i => i.id === id); if (item) { navigator.clipboard?.writeText(item.content); showToast("Copiado!"); } }
function reloadHistoryItem(id) { const item = generationHistory.find(i => i.id === id); if (item) { navigator.clipboard?.writeText(item.content); showToast(`Recarregado: "${item.content}"`); } }
function clearHistory() { if (confirm("Limpar histórico?")) { generationHistory = []; localStorage.setItem('generation_history', '[]'); renderHistoryList(); addLog('history_clear', 'Histórico limpo'); showToast("Histórico limpo"); } }

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
  batchResults = []; displayBatchResults(); skuBatchResults = []; displaySKUBatchResults();
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
  if (subviewId === 'batch') { batchResults = []; displayBatchResults(); }
  if (subviewId === 'sku') { document.getElementById('sku-product-name').value = ''; document.getElementById('sku-result-text').innerHTML = 'Aguardando entrada...'; }
  if (subviewId === 'skubatch') { skuBatchResults = []; displaySKUBatchResults(); document.getElementById('skubatch-import-file').value = ''; }
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

// ==================== PWA INSTALL MODAL ====================
function showInstallPWAModal() {
  const modal = document.getElementById('install-pwa-modal');
  if (modal) modal.classList.remove('hidden');
}
function closeInstallPWAModal() {
  const modal = document.getElementById('install-pwa-modal');
  if (modal) modal.classList.add('hidden');
}
function triggerInstallPrompt() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => {
      deferredPrompt = null;
      closeInstallPWAModal();
      document.getElementById('pwa-banner')?.classList.add('hidden');
    });
  } else {
    showToast("Seu navegador já instalou o app ou não suporta instalação direta. Tente pelo menu do navegador.", true);
  }
}

// ==================== INICIALIZAÇÃO E SERVICE WORKER ====================
let deferredPrompt;
function init() {
  loadLogsFromLocalStorage();
  loadFromLocalStorage();
  loadHistoryFromLocalStorage();
  initDefaultData();
  cleanInvalidRules();
  refreshAll();
  renderSKUConditionalRulesList();
  document.getElementById('batch-import-file').value = '';
  document.getElementById('skubatch-import-file').value = '';
  // Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('SW registrado', reg))
        .catch(err => console.log('Falha no SW', err));
    });
  }
  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const banner = document.getElementById('pwa-banner');
    if (banner) banner.classList.remove('hidden');
  });
  const installBannerBtn = document.getElementById('install-pwa-btn');
  if (installBannerBtn) installBannerBtn.addEventListener('click', () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt.userChoice.then(() => { deferredPrompt = null; document.getElementById('pwa-banner')?.classList.add('hidden'); }); } else showToast("Instalação não disponível agora", true); });
  const modalInstallBtn = document.getElementById('modal-install-btn');
  if (modalInstallBtn) modalInstallBtn.addEventListener('click', triggerInstallPrompt);
}
init();
