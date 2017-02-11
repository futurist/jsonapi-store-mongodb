var {buildQueryFromTree} = require('../lib/helper.js')
var assert = require('assert')

var testTree = [
  {field: 'parentID', table: 'form_lahuojihua'},
  {field: 'maker', table: 'form_charger'},
  {field: 'leader', table: 'form_charger'},
]

it('should query tree right', function() {
  assert.deepEqual(
    buildQueryFromTree(testTree),
    [
      {
        '$lookup': {
          from: 'form_lahuojihua',
          localField: 'parentID.id',
          foreignField: 'id',
          as: '__parentID'
        }
      },
      {
        '$unwind': '$__parentID'
      },
      {
        '$lookup': {
          from: 'form_charger',
          localField: '__parentID.maker.id',
          foreignField: 'id',
          as: '__parentID/maker'
        }
      },
      {
        '$unwind': '$__parentID/maker'
      },
      {
        '$lookup': {
          from: 'form_charger',
          localField: '__parentID/maker.leader.id',
          foreignField: 'id',
          as: '__parentID/maker/leader'
        }
      },
      {
        '$unwind': '$__parentID/maker/leader'
      }
    ]
  )
})
