(function () {
  const vscode = acquireVsCodeApi();
  const search = document.getElementById('search');
  const meta = document.getElementById('meta');
  const results = document.getElementById('results');

  function postSearch() {
    vscode.postMessage({ type: 'search', query: search.value });
  }

  function render(items, query, total) {
    meta.textContent = query
      ? `${total} match${total === 1 ? '' : 'es'} for "${query}"`
      : `${total} indexed entr${total === 1 ? 'y' : 'ies'}`;

    if (!items.length) {
      const fallback = document.createElement('div');
      fallback.className = 'empty';
      fallback.innerHTML = '<div>No indexed entry matches this search.</div>';

      if (query.trim()) {
        const button = document.createElement('button');
        button.textContent = 'Insert draft definition';
        button.addEventListener('click', () => {
          vscode.postMessage({ type: 'insertDefinition', query });
        });
        fallback.appendChild(document.createElement('div')).className = 'actions';
        fallback.lastChild.appendChild(button);
      }

      results.replaceChildren(fallback);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'card';
      const header = document.createElement('div');
      header.className = 'card-header';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.name;

      const kind = document.createElement('div');
      kind.className = 'kind';
      kind.textContent = item.kind;

      header.append(name, kind);

      const orthography = document.createElement('div');
      orthography.className = 'orthography';
      orthography.textContent = item.orthography;

      const definition = document.createElement('p');
      definition.className = 'definition';
      definition.textContent = item.definition || 'No definition recorded yet.';

      const location = document.createElement('div');
      location.className = 'location';
      location.textContent = item.location;

      const actions = document.createElement('div');
      actions.className = 'actions';

      const open = document.createElement('button');
      open.className = 'secondary';
      open.textContent = 'Open';
      open.addEventListener('click', () => {
        vscode.postMessage({ type: 'openEntry', id: item.id });
      });

      const insert = document.createElement('button');
      insert.textContent = 'Insert name';
      insert.addEventListener('click', () => {
        vscode.postMessage({ type: 'insertText', text: item.name });
      });

      actions.append(open, insert);
      card.append(header, orthography, definition, location, actions);
      fragment.appendChild(card);
    }

    results.replaceChildren(fragment);
  }

  search.addEventListener('input', postSearch);
  window.addEventListener('message', (event) => {
    const { type, items, query, total } = event.data;
    if (type === 'results') {
      render(items, query, total);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
