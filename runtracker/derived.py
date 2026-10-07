"""Charts worked out from what was logged: a name and a formula.

A training script does not always log the number you want to look at. This one logs the two terms of its loss but
not their sum; another logs rows seen and minutes but not rows a minute. A formula fills the gap without rerunning
anything, and applies to every run that has the names it uses:

    loss             = rebuild_error + lam * total_firing
    rows_per_minute  = rate(rows, minutes)

A name in a formula is a number the run logged ("rebuild_error", "sky.fired"), a hyperparameter it was started
with ("lam"), or one of two every run has: step, and seconds since its first line. The arithmetic is + - * / ** and brackets. The functions are log, log10, exp, sqrt, abs, min, max, and
rate(a, b): how fast a changes as b changes, from one logged line to the next.

Formulas are kept in derived.json in the data folder. They are read as arithmetic and nothing else: a formula cannot
call anything outside the list above.
"""
import ast, math, operator

from . import store

OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow,
       ast.USub: operator.neg, ast.UAdd: operator.pos}
FUNCS = {"log": math.log, "log10": math.log10, "exp": math.exp, "sqrt": math.sqrt, "abs": abs, "min": min, "max": max}


def load():
    return store.read_json(store.data_dir() / "derived.json", {}) or {}


def save(name, expr):
    """Keep a formula under a name, or drop the name if the formula is empty. Raises ValueError if it cannot be read."""
    name = name.strip()
    if not name or any(c in name for c in " =,"):
        raise ValueError("a chart needs a name with no spaces, such as loss")
    defs = load()
    if expr.strip():
        names(expr)
        defs[name] = {"expr": expr.strip()}
    else:
        defs.pop(name, None)
    store.write_json(store.data_dir() / "derived.json", defs)
    return defs


def _dotted(node):
    """sky.fired is written as one name; Python reads it as an attribute of sky."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        head = _dotted(node.value)
        return head + "." + node.attr if head else None
    return None


def _tree(expr):
    try:
        return ast.parse(expr.strip(), mode="eval").body
    except SyntaxError as e:
        raise ValueError("that formula cannot be read: %s" % e.msg)


def names(expr):
    """The logged numbers and hyperparameters a formula uses. Raises ValueError for anything that is not arithmetic."""
    out = set()

    def walk(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return
        if _dotted(n):
            out.add(_dotted(n)); return
        if isinstance(n, ast.BinOp) and type(n.op) in OPS:
            walk(n.left); walk(n.right); return
        if isinstance(n, ast.UnaryOp) and type(n.op) in OPS:
            walk(n.operand); return
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and (n.func.id in FUNCS or n.func.id == "rate") and not n.keywords:
            if n.func.id == "rate" and len(n.args) != 2:
                raise ValueError("rate takes two names: rate(rows, minutes)")
            for a in n.args:
                walk(a)
            return
        raise ValueError("a formula can use numbers, names, + - * / ** and %s" % ", ".join(sorted(FUNCS) + ["rate"]))

    walk(_tree(expr))
    return out


def evaluate(expr, columns, constants, length):
    """The formula's value on each logged line: a list of `length` numbers, None where it has no value.

    columns maps a logged name to its values per line (None where that line did not log it); constants maps a
    hyperparameter to its value.
    """
    def one(f, *vals):
        if any(v is None for v in vals):
            return None
        try:
            r = f(*vals)
            return r if isinstance(r, (int, float)) and math.isfinite(r) else None
        except (ValueError, ZeroDivisionError, OverflowError, TypeError):
            return None

    def spread(v):
        return v if isinstance(v, list) else [v] * length

    def ev(n):
        if isinstance(n, ast.Constant):
            return float(n.value)
        name = _dotted(n)
        if name:
            if name in columns:
                return columns[name]
            return float(constants[name]) if store.is_number(constants.get(name)) else None
        if isinstance(n, ast.BinOp):
            a, b = spread(ev(n.left)), spread(ev(n.right))
            return [one(OPS[type(n.op)], x, y) for x, y in zip(a, b)]
        if isinstance(n, ast.UnaryOp):
            return [one(OPS[type(n.op)], x) for x in spread(ev(n.operand))]
        if n.func.id == "rate":
            a, b = spread(ev(n.args[0])), spread(ev(n.args[1]))
            out, last = [None] * length, None
            for i in range(length):
                if a[i] is None or b[i] is None:
                    continue
                if last is not None:
                    out[i] = one(lambda da, db: da / db, a[i] - a[last], b[i] - b[last])
                last = i
            return out
        args = [spread(ev(a)) for a in n.args]
        return [one(FUNCS[n.func.id], *vals) for vals in zip(*args)]

    return spread(ev(_tree(expr)))
