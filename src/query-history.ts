import { all, type Expression } from './analysis.ts';

// Each source owns its history. Only successful applications enter it.
export class QueryHistory {
    private entries: Expression[];
    private cursor = 0;
    constructor(expression: Expression = all([])) { this.entries = [structuredClone(expression)]; }
    get applied(): Expression { return structuredClone(this.entries[this.cursor]); }
    get canUndo() { return this.cursor > 0; }
    get canRedo() { return this.cursor < this.entries.length - 1; }
    differs(expression: Expression) { return JSON.stringify(expression) !== JSON.stringify(this.entries[this.cursor]); }
    commit(expression: Expression) {
        if (!this.differs(expression)) return;
        this.entries.splice(this.cursor + 1);
        this.entries.push(structuredClone(expression));
        this.cursor++;
    }
    target(direction: 'undo' | 'redo'): Expression | undefined {
        if (direction === 'undo' ? !this.canUndo : !this.canRedo) return;
        return structuredClone(this.entries[this.cursor + (direction === 'undo' ? -1 : 1)]);
    }
    move(direction: 'undo' | 'redo') {
        if (this.target(direction)) this.cursor += direction === 'undo' ? -1 : 1;
    }
    reset(expression: Expression = all([])) { this.entries = [structuredClone(expression)]; this.cursor = 0; }
    discardObservations() {
        const prune = (e: Expression): Expression | undefined => {
            if (e.op === 'row') return;
            if (!('children' in e)) return e;
            const children = e.children.map(prune).filter((c): c is Expression => !!c);
            return e.children.length && !children.length ? undefined : { ...e, children };
        };
        // Old row indices must never be resurrected by undo after a reload.
        this.entries = this.entries.map(e => prune(e) ?? all([]));
    }
}
