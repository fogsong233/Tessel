import { type ReactElement, useEffect, useRef } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { vim } from '@replit/codemirror-vim';

interface MarkdownNoteEditorProps {
  value: string;
  vimMode: boolean;
  onChange(value: string): void;
}

export function MarkdownNoteEditor({ value, vimMode, onChange }: MarkdownNoteEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...(vimMode ? [vim()] : []),
          lineNumbers(),
          history(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': {
              height: '100%',
              color: '#202123',
              backgroundColor: '#ffffff',
              fontSize: '13px'
            },
            '.cm-scroller': {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              lineHeight: '1.55'
            },
            '.cm-content': {
              minHeight: '100%',
              padding: '12px 12px 18px'
            },
            '.cm-gutters': {
              color: '#8a8a8a',
              backgroundColor: '#fafafa',
              borderRight: '1px solid #eeeeee'
            },
            '.cm-activeLine': {
              backgroundColor: '#f7f7f7'
            },
            '.cm-activeLineGutter': {
              backgroundColor: '#f0f0f0'
            },
            '&.cm-focused': {
              outline: 'none'
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          })
        ]
      })
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = undefined;
    };
  }, [vimMode]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) {
      return;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: value
      }
    });
  }, [value]);

  return <div className="markdown-note-editor" ref={hostRef} />;
}
