/**
 * dsh-project-sources — client half.
 *
 * Codex-style "编辑项目" dialog: the workspace plus attached source folders,
 * each with an editable alias. Opens from the session
 * header (active session) and from the composer dock (session-creation page);
 * both drive the same sessionless `projectSources/*` remote API.
 *
 * It also contributes a companion `@` menu group, because the shipped `@`
 * provider is single-root and can never offer a file outside the workspace.
 */
window.__ModuleLoader__.load({
  id: 'dsh-project-sources',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'project-sources';

    // Official --dsw-alias-* design tokens with inert fallbacks.
    const TOKEN = {
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(127,127,127,0.20))',
      surface: 'var(--dsw-alias-bg-overlay, #ffffff)',
      subtle: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14))',
      ink: 'var(--dsw-alias-label-primary, #1a1a1a)',
      inkSoft: 'var(--dsw-alias-label-secondary, #4a4a4a)',
      inkMuted: 'var(--dsw-alias-label-tertiary, #6b6b6b)',
      inkFaint: 'var(--dsw-alias-label-caption, #8a8a8a)',
      danger: 'var(--dsw-alias-state-error-primary, #c62828)',
      accent: 'var(--dsw-alias-brand-primary, #4c6ef5)',
      onAccent: 'var(--dsw-alias-label-on-brand, #ffffff)',
      mask: 'var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.42))',
      shadow: '0 8px 24px var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.18))',
    };

    // ------------------------------------------------------------- store
    let state = {
      open: false,
      loading: false,
      busy: false,
      error: null,
      workspace: null,
      project: null,
    };
    const listeners = new Set();
    function patch(next) {
      state = Object.assign({}, state, next);
      listeners.forEach(function (fn) { fn(); });
    }
    function subscribe(fn) {
      listeners.add(fn);
      return function () { listeners.delete(fn); };
    }
    function getSnapshot() { return state; }
    function useStore() { return React.useSyncExternalStore(subscribe, getSnapshot); }

    function selectNothing(selector) { return selector(undefined); }

    const lastSegment = function (path) {
      const parts = String(path).replace(/[\\/]+$/, '').split(/[\\/]/);
      return parts[parts.length - 1] || 'source';
    };
    const slashed = function (path) { return String(path).replace(/\\/g, '/'); };
    const defaultAliasOf = function (path) {
      return lastSegment(path).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|-+$/g, '').slice(0, 40) || 'source';
    };

    function apply(_ctx) {
      const ctx = _ctx;

      function rpc(method, args, signal) {
        const connection = ctx.connection;
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.reject(new Error('project-sources: RPC channel unavailable'));
        }
        return connection.rpc.call('/api', 'projectSources/' + method, { args: args || {} }, signal).then(function (envelope) {
          if (!envelope || envelope.ok !== true) {
            const message = envelope && envelope.error !== undefined
              ? String(envelope.error.message !== undefined ? envelope.error.message : envelope.error)
              : 'remote call failed';
            throw new Error(String(message).replace(/^project-sources:\s*/, ''));
          }
          return envelope.value;
        });
      }

      function closePanel() {
        patch({ open: false, error: null });
      }

      function openFor(workspace) {
        patch({ open: true, loading: !!workspace, error: null, workspace: workspace || null, project: null });
        if (!workspace) return;
        rpc('get', { workspace: workspace }).then(function (project) {
          patch({ loading: false, project: project });
        }).catch(function (e) {
          patch({ loading: false, error: String(e && e.message ? e.message : e) });
        });
      }

      function saveProject(workspace, payload) {
        patch({ busy: true, error: null });
        return rpc('set', { workspace: workspace, payload: payload }).then(function (project) {
          patch({ busy: false, project: project });
          closePanel();
        }).catch(function (e) {
          patch({ busy: false, error: String(e && e.message ? e.message : e) });
        });
      }

      /** Workspace path of a session from the sessions snapshot. */
      function workspaceOfSession(sessionId) {
        const sessions = ctx.sessions;
        if (!sessions || !sessions.list) return null;
        const snapshot = sessions.list.getSnapshot();
        const row = snapshot && snapshot.byId && sessionId !== undefined ? snapshot.byId[sessionId] : undefined;
        return row && row.cwd ? row.cwd : null;
      }

      // ------------------------------------------------------------ panel
      function ProjectPanel(props) {
        const store = useStore();
        const [name, setName] = React.useState('');
        const [sources, setSources] = React.useState([]);
        const [newPath, setNewPath] = React.useState('');
        const [manual, setManual] = React.useState(false);
        const [picking, setPicking] = React.useState(false);
        const [pickNote, setPickNote] = React.useState(null);
        const pickRef = React.useRef(null);

        React.useEffect(function () {
          if (!store.project) return;
          setName(store.project.name || '');
          setSources((store.project.sources || []).map(function (source) {
            return { path: source.path, alias: source.alias, isWorkspace: source.isWorkspace === true };
          }));
          setNewPath('');
          setManual(false);
          setPicking(false);
          setPickNote(null);
        }, [store.project]);

        React.useEffect(function () {
          if (!store.open) return undefined;
          function onKey(event) {
            if (event.key === 'Escape') closePanel();
          }
          document.addEventListener('keydown', onKey);
          return function () {
            document.removeEventListener('keydown', onKey);
            if (pickRef.current) { pickRef.current.abort(); pickRef.current = null; }
          };
        }, [store.open]);

        if (!store.open) return null;

        const inputStyle = {
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid ' + TOKEN.border,
          background: 'transparent',
          color: TOKEN.ink,
          fontSize: 13,
          fontFamily: 'inherit',
          outline: 'none',
        };
        const smallButton = function (extra) {
          return Object.assign({
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid ' + TOKEN.border,
            background: 'transparent',
            color: TOKEN.inkSoft,
            fontSize: 12,
            fontFamily: 'inherit',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }, extra || {});
        };

        function updateAlias(index, value) {
          setSources(function (list) {
            const next = list.slice();
            next[index] = Object.assign({}, next[index], { alias: value });
            return next;
          });
        }
        function removeSource(index) {
          setSources(function (list) {
            const next = list.filter(function (_item, i) { return i !== index; });
            return next;
          });
        }
        function addPath(path) {
          const clean = String(path).trim().replace(/^["']|["']$/g, '');
          if (clean.length === 0) return;
          setSources(function (list) {
            const exists = list.some(function (item) {
              return String(item.path).replace(/\\/g, '/').toLowerCase() === clean.replace(/\\/g, '/').toLowerCase();
            });
            if (exists) return list;
            return list.concat([{ path: clean, alias: defaultAliasOf(clean), isWorkspace: false }]);
          });
          setNewPath('');
          setManual(false);
          setPickNote(null);
        }
        function addSource() {
          addPath(newPath);
        }

        /** Open the host's folder chooser (a real Explorer-style dialog on the
         *  host desktop). When no chooser can answer, the manual path field
         *  takes over and says why. */
        function startPick() {
          setPickNote(null);
          setPicking(true);
          const controller = new AbortController();
          pickRef.current = controller;
          rpc('pick', {}, controller.signal).then(function (value) {
            if (pickRef.current === controller) pickRef.current = null;
            setPicking(false);
            if (value && value.path) { addPath(value.path); return; }
            if (value && value.via === 'native') return; // the operator cancelled
            setManual(true);
            setPickNote('系统文件夹对话框不可用，请粘贴绝对路径。');
          }).catch(function (e) {
            if (pickRef.current === controller) pickRef.current = null;
            setPicking(false);
            setManual(true);
            setPickNote(
              '文件夹选择器不可用：' + (e && e.message ? e.message : e) +
                '。若刚更新过插件，重启 DSH 后会加载选择器；也可以直接粘贴绝对路径。',
            );
          });
        }
        function submit() {
          saveProject(store.workspace, {
            name: name,
            sources: sources.map(function (source) {
              return { path: source.path, alias: source.alias };
            }),
          });
        }

        const rows = sources.map(function (source, index) {
          return h(
            'div',
            {
              key: source.path + '#' + index,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                marginBottom: 6,
                borderRadius: 8,
                border: '1px solid ' + TOKEN.borderSoft,
                background: TOKEN.subtle,
              },
            },
            h('span', { style: { fontSize: 15, opacity: 0.85 } }, '📁'),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('input', {
                value: source.alias,
                onChange: function (event) { updateAlias(index, event.target.value); },
                spellCheck: false,
                'aria-label': '别名',
                style: {
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '2px 4px',
                  borderRadius: 4,
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: TOKEN.ink,
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  outline: 'none',
                },
                onFocus: function (event) {
                  event.target.style.borderColor = TOKEN.border;
                  event.target.style.background = TOKEN.surface;
                },
                onBlur: function (event) {
                  event.target.style.borderColor = 'transparent';
                  event.target.style.background = 'transparent';
                },
              }),
              h(
                'div',
                {
                  title: source.path,
                  style: {
                    padding: '0 4px',
                    color: TOKEN.inkFaint,
                    fontSize: 11,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                source.path,
              ),
            ),
            source.isWorkspace
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    title: '移除此文件夹',
                    onClick: function () { removeSource(index); },
                    style: smallButton({
                      border: '1px solid transparent',
                      color: TOKEN.inkMuted,
                      fontSize: 14,
                      padding: '2px 6px',
                    }),
                  },
                  '×',
                ),
          );
        });

        return h(
          'div',
          {
            onClick: closePanel,
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: TOKEN.mask,
            },
          },
          h(
            'div',
            {
              onClick: function (event) { event.stopPropagation(); },
              style: {
                width: 560,
                maxWidth: 'calc(100vw - 40px)',
                maxHeight: 'calc(100vh - 80px)',
                overflowY: 'auto',
                boxSizing: 'border-box',
                background: TOKEN.surface,
                color: TOKEN.ink,
                border: '1px solid ' + TOKEN.border,
                borderRadius: 14,
                boxShadow: TOKEN.shadow,
                padding: 20,
                fontSize: 13,
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 } },
              h('div', { style: { fontSize: 16, fontWeight: 600 } }, '编辑项目'),
              h(
                'button',
                {
                  type: 'button',
                  title: '关闭',
                  onClick: closePanel,
                  style: smallButton({ border: '1px solid transparent', fontSize: 16, color: TOKEN.inkMuted }),
                },
                '×',
              ),
            ),

            h('div', { style: { color: TOKEN.inkMuted, fontSize: 12, marginBottom: 6 } }, '项目名称'),
            h('input', {
              value: name,
              spellCheck: false,
              onChange: function (event) { setName(event.target.value); },
              style: Object.assign({}, inputStyle, { marginBottom: 16 }),
            }),

            h('div', { style: { color: TOKEN.inkMuted, fontSize: 12, marginBottom: 6 } }, '源文件夹'),
            store.loading
              ? h('div', { style: { padding: '10px 0', color: TOKEN.inkFaint, fontSize: 12 } }, '读取中…')
              : h('div', null, rows),

            manual
              ? h(
                  'div',
                  { style: { marginTop: 4, marginBottom: 4 } },
                  pickNote
                    ? h('div', { style: { color: TOKEN.inkFaint, fontSize: 11, marginBottom: 6, lineHeight: 1.4 } }, pickNote)
                    : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8 } },
                    h('input', {
                      autoFocus: true,
                      value: newPath,
                      spellCheck: false,
                      placeholder: '绝对路径，例如 D:\\work\\other-repo',
                      onChange: function (event) { setNewPath(event.target.value); },
                      onKeyDown: function (event) {
                        if (event.key === 'Enter') { event.preventDefault(); addSource(); }
                        if (event.key === 'Escape') { setManual(false); setNewPath(''); setPickNote(null); }
                      },
                      style: Object.assign({}, inputStyle, { flex: 1 }),
                    }),
                    h('button', { type: 'button', onClick: addSource, style: smallButton({}) }, '添加'),
                    h(
                      'button',
                      {
                        type: 'button',
                        title: '改用系统文件夹对话框',
                        onClick: startPick,
                        style: smallButton({ border: '1px solid transparent' }),
                      },
                      '选择…',
                    ),
                  ),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    disabled: picking,
                    onClick: startPick,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '9px 10px',
                      marginTop: 4,
                      borderRadius: 8,
                      border: '1px dashed ' + TOKEN.border,
                      background: 'transparent',
                      color: TOKEN.inkMuted,
                      fontSize: 12,
                      fontFamily: 'inherit',
                      cursor: picking ? 'default' : 'pointer',
                      opacity: picking ? 0.6 : 1,
                    },
                  },
                  h('span', { style: { fontSize: 14 } }, '＋'),
                  picking ? '选择文件夹中…' : '添加文件夹',
                ),

            store.error
              ? h('div', { style: { marginTop: 12, color: TOKEN.danger, fontSize: 12, whiteSpace: 'pre-wrap' } }, store.error)
              : null,

            h(
              'div',
              { style: { marginTop: 12, color: TOKEN.inkFaint, fontSize: 11, lineHeight: 1.5 } },
              '别名用于在会话中引用：@' + (sources[0] ? sources[0].alias : 'alias') + '/src/file.ts。所有源文件夹与主工作区享有相同的读写与命令权限。',
            ),

            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 } },
              h('button', { type: 'button', onClick: closePanel, style: smallButton({ padding: '7px 16px' }) }, '取消'),
              h(
                'button',
                {
                  type: 'button',
                  disabled: store.busy,
                  onClick: submit,
                  style: {
                    padding: '7px 18px',
                    borderRadius: 8,
                    border: '1px solid ' + TOKEN.accent,
                    background: TOKEN.accent,
                    color: TOKEN.onAccent,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    cursor: store.busy ? 'default' : 'pointer',
                    opacity: store.busy ? 0.6 : 1,
                  },
                },
                store.busy ? '保存中…' : '保存',
              ),
            ),
          ),
        );
      }

      // ------------------------------------------------------- openers
      function HeaderButton(props) {
        const store = useStore();
        const sessionId = props.sessionId;
        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing;
        const workspace = useSessions(function (snapshot) {
          const row = snapshot && snapshot.byId && sessionId !== undefined ? snapshot.byId[sessionId] : undefined;
          return row && row.cwd ? row.cwd : null;
        });
        const open = store.open && store.workspace === workspace;
        return h(
          'button',
          {
            type: 'button',
            title: workspace ? '编辑项目（源文件夹）' : '请先选择工作区',
            disabled: !workspace,
            onClick: function () { if (open) closePanel(); else openFor(workspace); },
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 8,
              border: '1px solid ' + TOKEN.border,
              background: open ? TOKEN.hover : 'transparent',
              color: workspace ? TOKEN.ink : TOKEN.inkFaint,
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: workspace ? 'pointer' : 'default',
            },
          },
          '项目',
        );
      }

      /** Session-creation entry: a small pill in the composer dock band. */
      function DockChip(props) {
        const sessionId = props.sessionId;
        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : selectNothing;
        const blank = useSessions(function (snapshot) {
          const row = snapshot && snapshot.byId && sessionId !== undefined ? snapshot.byId[sessionId] : undefined;
          return !!(row && row.blank === true);
        });
        const workspace = useSessions(function (snapshot) {
          const row = snapshot && snapshot.byId && sessionId !== undefined ? snapshot.byId[sessionId] : undefined;
          return row && row.cwd ? row.cwd : null;
        });
        if (!blank || !workspace) return null;
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', minWidth: 0, paddingLeft: 20 } },
          h(
            'button',
            {
              type: 'button',
              title: '编辑项目（源文件夹）',
              onClick: function () { openFor(workspace); },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                borderRadius: 999,
                border: '1px solid ' + TOKEN.border,
                background: 'transparent',
                color: TOKEN.inkSoft,
                fontSize: 12,
                fontFamily: 'inherit',
                cursor: 'pointer',
              },
            },
            '📁 项目源文件夹',
          ),
        );
      }

      // ------------------------------------------------------- @ menu
      /** Mention text for one absolute path. Whitespace quotes it; a quoted
       *  directory keeps its quote open so completion can descend. */
      function formatMention(path, kind) {
        const text = kind === 'directory' ? path + '/' : path;
        if (/[\u0000-\u001f\u007f-\u009f"]/.test(text)) return undefined;
        if (!/\s/.test(text)) return '@' + text;
        return kind === 'directory' ? '@"' + text : '@"' + text + '"';
      }

      function fileRow(candidate) {
        const path = slashed(candidate.path || '');
        const kind = candidate.kind === 'directory' ? 'directory' : 'file';
        const mention = formatMention(path, kind);
        if (mention === undefined) return [];
        const rel = String(candidate.rel || '');
        const name = rel === '' ? lastSegment(path) : lastSegment(rel);
        const slash = rel.lastIndexOf('/');
        const parent = slash < 0 ? '' : rel.slice(0, slash);
        return [{
          name: kind === 'directory' ? name + '/' : name,
          ...(parent === '' ? {} : { description: parent }),
          icon: kind === 'directory' ? 'folder' : 'file',
          section: String(candidate.alias || ''),
          value: JSON.stringify({ kind: kind, path: path, mention: mention }),
          ...(kind === 'directory' ? { drill: true } : {}),
        }];
      }

      function rowValue(value) {
        if (typeof value !== 'string') return undefined;
        try {
          const parsed = JSON.parse(value);
          return parsed && typeof parsed.mention === 'string' ? parsed : undefined;
        } catch (_) {
          return undefined;
        }
      }

      /** Sources of one workspace, cached for a few seconds so typing in the
       *  `@` menu does not issue a `get` call per keystroke. */
      const sourcesCache = {};
      function sourcesFor(workspace) {
        const key = slashed(workspace).toLowerCase();
        const hit = sourcesCache[key];
        if (hit && Date.now() - hit.at < 4000) return hit.promise;
        const promise = rpc('get', { workspace: workspace }).then(function (project) {
          return project && Array.isArray(project.sources) ? project.sources : [];
        });
        sourcesCache[key] = { at: Date.now(), promise: promise };
        promise.catch(function () { delete sourcesCache[key]; });
        return promise;
      }

      function sourceKeysOf(source) {
        return [String(source.alias).toLowerCase(), lastSegment(source.path).toLowerCase()];
      }

      function resolveSource(sources, segment) {
        const needle = segment.toLowerCase();
        let exact = null;
        const near = [];
        for (const source of sources) {
          const keys = sourceKeysOf(source);
          if (keys.indexOf(needle) >= 0) {
            if (exact === null) exact = source;
          } else if (keys.some(function (key) { return key.indexOf(needle) === 0; })) {
            near.push(source);
          }
        }
        return { exact: exact, near: near };
      }

      /** `koa/` in the composer names the source whose folder is `koa-…`:
       *  hand the host the absolute level it can already list. */
      function effectiveQuery(query, sources) {
        const text = slashed(String(query || ''));
        if (text === '' || text.charAt(0) === '/' || /^[A-Za-z]:\//.test(text)) return query;
        const slash = text.indexOf('/');
        if (slash <= 0) return query;
        const match = resolveSource(sources, text.slice(0, slash));
        const target = match.exact || (match.near.length === 1 ? match.near[0] : null);
        if (target === null) return query;
        return slashed(target.path).replace(/\/+$/, '') + '/' + text.slice(slash + 1);
      }

      /** Source folders a bare fragment names, offered ahead of the file hits. */
      function folderCandidates(query, sources, existing) {
        const text = slashed(String(query || ''));
        if (text.indexOf('/') >= 0) return [];
        const needle = text.toLowerCase();
        const seen = {};
        for (const item of existing) seen[slashed(item.path).toLowerCase()] = true;
        const rows = [];
        for (const source of sources) {
          if (source.isWorkspace) continue;
          const path = slashed(source.path);
          if (seen[path.toLowerCase()]) continue;
          if (sourceKeysOf(source).some(function (key) { return key.indexOf(needle) >= 0; })) {
            rows.push({ alias: source.alias, dir: source.path, rel: '', kind: 'directory', path: path });
          }
        }
        return rows;
      }

      ctx.inject(['inputTriggers'], function (scope) {
        const registry = scope.inputTriggers;
        if (!registry || typeof registry.registerSource !== 'function') return;
        scope.effect(function () {
          return registry.registerSource({
            trigger: '@',
            name: NS,
            order: 11,
            showGroupTitle: false,
            candidates: function (session, request) {
              const workspace = workspaceOfSession(session && session.sessionId);
              if (!workspace) return Promise.resolve([]);
              const raw = String(request.query || '');
              return sourcesFor(workspace).then(function (sources) {
                return rpc('listFiles', { workspace: workspace, query: effectiveQuery(raw, sources) }).then(
                  function (value) {
                    const items = value && Array.isArray(value.candidates) ? value.candidates.slice() : [];
                    const merged = folderCandidates(raw, sources, items).concat(items);
                    let rows = [];
                    for (let i = 0; i < merged.length; i += 1) rows = rows.concat(fileRow(merged[i]));
                    return rows;
                  },
                  function () { return []; },
                );
              }, function () { return []; });
            },
            onPick: function (pick) {
              const chosen = rowValue(pick.candidate.value);
              if (chosen === undefined) return undefined;
              const name = lastSegment(chosen.path);
              if (chosen.kind === 'directory' && pick.action === 'drill') {
                return { text: chosen.mention, continue: true };
              }
              return {
                insert: {
                  source: NS,
                  ref: chosen.mention,
                  label: chosen.kind === 'directory' ? name + '/' : name,
                  appearance: chosen.kind === 'directory' ? 'folder' : 'file',
                  clipboardText: chosen.mention,
                },
              };
            },
            codec: {
              clipboardText: function (ref) { return ref; },
              serialize: function (ref) { return Promise.resolve(ref); },
            },
          });
        }, 'dsh-project-sources: @ discovery source');
      });

      // ------------------------------------------------- registrations
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register(
          { name: 'conversation.session.header.actions', id: 'project-sources', order: 31, label: '项目' },
          HeaderButton,
        );
      });

      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register(
          { name: 'conversation.input.dock', id: 'project-sources', order: 121, label: '项目源文件夹' },
          DockChip,
        );
      });

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          { name: 'shell.overlay', id: 'project-sources', order: 210, label: '项目' },
          ProjectPanel,
        );
      });
    }

    return {
      name: NS,
      inject: ['slots', 'connection', 'sessions'],
      apply: apply,
    };
  },
});