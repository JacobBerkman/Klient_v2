export function throwRepositoryScaffoldError(className, methodName) {
  const error = new Error(
    `${className}.${methodName} is scaffold-only and must be provided by a runtime adapter.`
  )
  error.code = 'REPOSITORY_SCAFFOLD_ONLY'
  error.statusCode = 500
  throw error
}

