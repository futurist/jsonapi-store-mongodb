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

/*
 * The tkey tree is: ~/field1/field2/lastField
 * ~ will be parentID
 * field1 will expand to {field, table, tkey, form}
 * lastField always ignored
 */
function getFormTree (segment, baseform, _resources) {
  if (segment.length < 1) return
  var last = null
  var result = []
  segment.forEach(field => {
    if (last && last.err) return
    const base = _resources[baseform]
    const attributes = base.attributes
    if (field == '~') {
      field = 'parentID'
    }
    const joiType = attributes[field]
    const settings = joiType && joiType._settings
    if (!settings) {
      return result.push(last = {field, err: 'invalid_field'})
    }
    // console.log(field, baseform, settings)
    const table = settings.__one || settings.__many
    const tkey = settings.__tkey || 'id'
    const form = _resources[table]
    baseform = table
    last = {field, table, tkey}
    if (form) last.form = form
    else last.err = 'invalid_form'
    result.push(last)
  })
  return result
}


/* The target query is:
  db.form_lahuojihua_list.aggregate([
  {"$match":{"$and":[{"$or":[{}]}]}},
  {"$lookup":{"from":"form_lahuojihua","localField":"parentID.id","foreignField":"id","as":"__parentID"}},
  {$unwind: '$__parentID'},
  {"$lookup":{"from":"form_charger","localField":"__parentID.maker.id","foreignField":"id","as":"__parentID/maker"}},
  {$unwind: '$__parentID/maker'},
  {"$lookup":{"from":"form_charger","localField":"__parentID/maker.leader.id","foreignField":"id","as":"__parentID/maker/leader"}},
  {$unwind: "$__parentID/maker/leader"}
])
  */
function buildQueryFromTree(tkeyTree) {
  var query = []
  var parentPath = []
  tkeyTree.forEach(function(v) {
    let parent = parentPath.join('/')
    parent = parent ? '__' + parent + '.' : ''
    parentPath.push(v.field)
    const tableName = '__' + parentPath.join('/')
    query.push({"from":v.table,"localField": parent + v.field + ".id", "foreignField":"id","as":tableName})
    // query.push({"$lookup":{"from":v.table,"localField": parent + v.field + ".id", "foreignField":"id","as":tableName}})
    // query.push({$unwind: '$'+tableName})
  })
  return query
}

function getTkey (form) {
  const str = form.tkey
  return str ? str.trim().split('\n') : []
}

function addToSet () {
  var i, isFirst, args = Array.prototype.slice.call(arguments, 0)
  if (typeof args[0] === 'boolean') isFirst = args.shift()
  var arr = args.shift()
  if (arr === null || typeof arr !== 'object') arr = []
  for (i in args) {
    if (arr.indexOf(args[i]) < 0) {
      isFirst ? arr.unshift(args[i]) : arr.push(args[i])
    }
  }
  return arr
}

module.exports = {
  addToSet,
  buildQueryFromTree,
  str2Query,
  joiCastValue,
  getFormTree,
  getTkey
}
