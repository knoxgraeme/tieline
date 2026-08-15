; SQL declarations only. Dependency/reference resolution remains a separate topology phase.

(program
  (statement
    (create_table
      (object_reference
        name: (identifier) @symbol.name)) @symbol.declaration))

(program
  (statement
    (create_view
      (object_reference
        name: (identifier) @symbol.name)) @symbol.declaration))

(program
  (statement
    (create_function
      (object_reference
        name: (identifier) @symbol.name)
      (function_arguments)) @symbol.declaration))
