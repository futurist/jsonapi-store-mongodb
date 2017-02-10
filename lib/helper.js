var joi = require('joi')

function str2Query (value, joiType) {
  var castValue = function (v, start) {
    return joiCastValue(v, start, joiType)
  }
  if (value[0] === '<') return value[1] === '=' ? { $lte: castValue(value, 2) } : { $lt: castValue(value, 1) }
  if (value[0] === '>') return value[1] === '=' ? { $gte: castValue(value, 2) } : { $gt: castValue(value, 1) }
  if (value[0] === '~') return new RegExp('^' + castValue(value, 1) + '$', 'i')
  if (value[0] === ':') return new RegExp(castValue(value, 1))
  return castValue(value)
}

function joiCastValue (v, start, joiType) {
  const str = v.substring(start || 0)
  const val = joiType ? joi.attempt(str, joiType) : str
  return val
}

/**
 * Convert formpath(lahuojihua/name) into mongo query
 * @param {string} path lahuojihua/name
 */
function getFormsFromSegment (segment, request, self) {
  var _resources = self.resourceConfig._resources
  var colName = request.params.type
  if (segment.length < 1) return
  const parent = segment[0]
  const externalForm = _resources['form_' + parent]
  const attributes = externalForm ? _resources['form_' + parent].attributes : {}
  const parentKey = '__' + parent
  const parentField = parent
  if (parent == '~') {
    parentField = 'parentID'
    parent = attributes.table
  }
  query.push(
    // result name is __lahuojihua, __ indicate foreign
    {$lookup: {from: 'form_' + parent, localField: 'parentID.id', foreignField: 'id', as: parentKey }}
  )

  const condition = filterp[parent]
  // matchP from filterP, but convert to $regex
  const matchp = {}
  if (condition) {
    Object.keys(condition).forEach(v => {
      if (condition[v][0] == ':') {
        // fizzy match
        matchp[v] = {$regex: joiCastValue(condition[v], 1, attributes[v]), $options: 'i'}
      } else {
        matchp[v] = joiCastValue(condition[v], 0, attributes[v])
      }
    })
    // {$match: {__lahuojihua: {$elemMatch:{ adate: "28"} } } }
    query.push({$match: { [parentKey]: {$elemMatch: matchp} } })
  }
}

function getFormTree (strPath, baseform, _resources) {
  const segment = strPath.split('/')
  if (segment.length < 1) return
  return segment.map(field => {
    const attributes = _resources[baseform].attributes
    if (field == '~') {
      field = 'parentID'
    }
    const settings = attributes[field]._settings
    console.log(field, baseform, settings)
    const table = settings.__one || settings.__many
    const tkey = settings.__tkey || 'id'
    const form = _resources[table]
    baseform = table
    return {
      field,
      table,
      tkey,
      form
    }
  })
}

function getTkeyArray (form) {
  const str = form.attributes.tkey
  return str ? str.split('\n') : []
}

module.exports = {
  str2Query,
  joiCastValue,
  getFormTree
}
