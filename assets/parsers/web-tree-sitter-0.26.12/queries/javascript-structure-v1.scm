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

(export_statement
  source: (string
    (string_fragment) @reference.source)) @reference.reexport

(export_statement) @reference.export

