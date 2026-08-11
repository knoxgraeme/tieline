; Tieline Rust syntax facts. Resolution remains a separate topology phase.
(struct_item
  name: (type_identifier) @symbol.name) @symbol.declaration

(enum_item
  name: (type_identifier) @symbol.name) @symbol.declaration

(trait_item
  name: (type_identifier) @symbol.name) @symbol.declaration

(type_item
  name: (type_identifier) @symbol.name) @symbol.declaration

(associated_type
  name: (type_identifier) @symbol.name) @symbol.declaration

(mod_item
  name: (identifier) @symbol.name) @symbol.declaration

(function_item
  name: (identifier) @symbol.name) @symbol.declaration

(function_signature_item
  name: (identifier) @symbol.name) @symbol.declaration

(const_item
  name: (identifier) @symbol.name) @symbol.declaration

(static_item
  name: (identifier) @symbol.name) @symbol.declaration

(impl_item) @symbol.impl_owner

(use_declaration) @reference.use
