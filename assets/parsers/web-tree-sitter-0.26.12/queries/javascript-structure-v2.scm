; Tieline JavaScript/JSX syntax facts. Keep every declaration name field-qualified.
(function_declaration
  name: (identifier) @symbol.name) @symbol.declaration

(generator_function_declaration
  name: (identifier) @symbol.name) @symbol.declaration

(class_declaration
  name: (identifier) @symbol.name) @symbol.declaration

(method_definition
  name: [
    (property_identifier)
    (private_property_identifier)
    (string)
    (number)
  ] @symbol.name) @symbol.declaration

(variable_declarator
  name: (identifier) @symbol.name) @symbol.declaration

(export_statement
  value: [
    (class)
    (function_expression)
    (generator_function)
  ] @symbol.declaration) @symbol.anonymous_export

(import_statement
  source: (string
    (string_fragment) @reference.source)) @reference.import

(call_expression
  function: (import)
  arguments: (arguments
    (string
      (string_fragment) @reference.source))) @reference.dynamic_import

; A second capture keeps non-literal dynamic imports as explicit unresolved facts.
(call_expression
  function: (import)) @reference.dynamic_import

; CommonJS resolution is limited to the literal, unshadowed-looking syntax fact.
; Name binding and runtime shadowing are intentionally outside this syntax phase.
((call_expression
  function: (identifier) @reference.require_function
  arguments: (arguments
    (string
      (string_fragment) @reference.source))) @reference.import
  (#eq? @reference.require_function "require"))

(export_statement
  source: (string
    (string_fragment) @reference.source)) @reference.reexport

(export_statement) @reference.export
