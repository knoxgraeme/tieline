; Tieline Python syntax facts. Resolution remains a separate topology phase.
(function_definition
  name: (identifier) @symbol.name) @symbol.declaration

(class_definition
  name: (identifier) @symbol.name) @symbol.declaration

(import_statement) @reference.import

(import_from_statement) @reference.import_from

(future_import_statement) @reference.import_from
