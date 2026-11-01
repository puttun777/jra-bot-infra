# jra-bot-web の tools/release/jsonschema_lite.py の写し（標準ライブラリのみ。未対応キーワードは拒否 = fail closed）
"""JSON Schema の必要最小限の検証器（標準ライブラリだけ）。

release-manifest のスキーマが使うキーワードだけを実装し、**未対応のキーワードがスキーマにあれば検証を拒否する**（fail closed。
黙って検査を落とさない）。スキーマ自体は標準の JSON Schema なので、infra 側は任意の検証器で同じファイルを使える。
"""
from __future__ import annotations

import re
from typing import Any

ANNOTATIONS = {"$schema", "$id", "$comment", "title", "description", "examples", "default"}
SUPPORTED = {
    "type", "const", "enum", "pattern", "required", "properties", "additionalProperties",
    "items", "minItems", "maxItems", "uniqueItems", "minimum", "maximum", "minLength", "maxLength",
}


class UnsupportedSchema(ValueError):
    pass


def _type_ok(value: Any, name: str) -> bool:
    if name == "null":
        return value is None
    if name == "boolean":
        return isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "string":
        return isinstance(value, str)
    if name == "array":
        return isinstance(value, list)
    if name == "object":
        return isinstance(value, dict)
    raise UnsupportedSchema(f"未対応の type: {name}")


def check_schema_supported(schema: Any, path: str = "#") -> None:
    if not isinstance(schema, dict):
        raise UnsupportedSchema(f"{path}: スキーマがオブジェクトではない")
    for key, sub in schema.items():
        if key in ANNOTATIONS:
            continue
        if key not in SUPPORTED:
            raise UnsupportedSchema(f"{path}: 未対応のキーワード {key}")
        if key == "properties":
            for name, s in sub.items():
                check_schema_supported(s, f"{path}/properties/{name}")
        elif key == "items":
            check_schema_supported(sub, f"{path}/items")
        elif key == "additionalProperties" and not isinstance(sub, bool):
            raise UnsupportedSchema(f"{path}: additionalProperties は真偽値だけ対応")


def validate(value: Any, schema: dict, path: str = "$") -> list[str]:
    """違反を人が読める文字列のリストで返す（空なら適合）。パスワードのような値は出さない用途ではないが、値は長さを切って出す。"""
    check_schema_supported(schema)
    return _validate(value, schema, path)


def _short(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 80 else text[:77] + "..."


def _validate(value: Any, schema: dict, path: str) -> list[str]:
    errors: list[str] = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            return [f"{path}: 型が {types} ではない（{_short(value)}）"]
    if "const" in schema and (value != schema["const"] or type(value) is not type(schema["const"])):
        errors.append(f"{path}: {_short(schema['const'])} でなければならない（{_short(value)}）")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {schema['enum']} のいずれかでなければならない（{_short(value)}）")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: 形式が不正（{_short(value)}）。期待: {schema['pattern']}")
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: 短すぎる")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: 長すぎる（{len(value)} > {schema['maxLength']}）")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: {schema['minimum']} 以上でなければならない")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: {schema['maximum']} 以下でなければならない")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: 要素が {schema['minItems']} 個以上必要")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: 要素が多すぎる")
        if schema.get("uniqueItems") and len({repr(v) for v in value}) != len(value):
            errors.append(f"{path}: 要素が重複している")
        if "items" in schema:
            for i, v in enumerate(value):
                errors += _validate(v, schema["items"], f"{path}[{i}]")
    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append(f"{path}.{name}: 必須フィールドが無い")
        props = schema.get("properties", {})
        for name, v in value.items():
            if name in props:
                errors += _validate(v, props[name], f"{path}.{name}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{name}: 未知のフィールド")
    return errors
